/**
 * File-based persistence for disk-import scan sessions (#1896).
 *
 * Why this exists: `service.ts` used to hold reviewed-but-not-applied scan
 * plans in a process-local `Map` (the review gate — apply requires a session
 * scanned in THIS process). That meant a backend restart between scan and
 * apply silently dropped the reviewed plan: a reopened disk-import card had
 * no way to re-attach to the session it was reviewing, and the apply gate
 * could only ever see sessions created since the last boot.
 *
 * This module persists each session to its own atomic state file under
 * DATA_DIR + an append-only log file, modeled directly on
 * `lib/install/jobStore.ts`:
 *
 *   - a reopened card can re-attach to a reviewed plan by session id
 *   - the reviewed plan + apply reference survive a backend restart
 *   - a crash leaves a breadcrumb (PROCESS_STARTED_AT)
 *
 * Session state files are small (a plan over a few thousand records is well
 * under a few hundred KB) so a full read/write per update is fine — this is
 * not a hot path. The store is the only thing this unit changes; async/
 * progress (#1897) and batched host-work (#1898) build on top.
 */
import fs from 'fs/promises';
import path from 'path';

import { DATA_DIR } from '@/lib/dirs';

import type { ImportPlan, Rule } from './types';

const SESSIONS_DIR = path.join(DATA_DIR, 'disk-import-sessions');

/** Captured at module load — effectively this backend process's start time.
 *  A session whose `seenBy` differs from the current process started before
 *  the last restart; the breadcrumb lets a reopened card tell a survivor
 *  session from one created in this process, mirroring jobStore's
 *  PROCESS_STARTED_AT. */
export const PROCESS_STARTED_AT = new Date().toISOString();

/** Pruning threshold — keep this many most-recent sessions on disk so a
 *  reopened card can still re-attach to a recently-reviewed plan. Older
 *  sessions are cleaned up on each createSession call. Mirrors jobStore's
 *  KEEP_RECENT_JOBS. */
const KEEP_RECENT_SESSIONS = 20;

/**
 * Lifecycle of a disk-import job (#1897). A scan and an apply both run in the
 * background, so the card polls this phase:
 *
 *   scanning  → mount/walk/hash/plan in flight (no plan yet)
 *   reviewed  → plan ready; awaiting the operator's CONFIRM (the review gate)
 *   applying  → apply (copy/chown/upload) in flight
 *   applied   → apply finished; session consumed (one apply per review)
 *   error     → the background scan or apply threw; `error` carries the message
 *
 * The apply gate still keys off `reviewed`: apply is refused unless the session
 * is in `reviewed` (a `scanning`/`applying`/`applied`/`error` session can't be
 * applied). Mirrors jobStore's JobPhase.
 */
export type SessionPhase = 'scanning' | 'reviewed' | 'applying' | 'applied' | 'error';

/** Which background pass a session is running (#1897). Drives the card's phase
 *  label + which count set is meaningful. */
export type SessionStep =
  | 'mount'
  | 'walk'
  | 'hash'
  | 'plan'
  | 'copy'
  | 'done';

/** Live progress counters the status route exposes so the card can render a
 *  phase + counts instead of a bare spinner (#1897). All monotonic within a
 *  pass; `total` is the denominator once known (0 until the walk finishes). */
export interface SessionProgress {
  /** The host-side pass currently running. */
  step: SessionStep;
  scanned: number;
  hashed: number;
  copied: number;
  bytes: number;
  /** Denominator for the active pass (files to hash, then items to apply). 0
   *  while still walking (unknown). */
  total: number;
}

function emptyProgress(): SessionProgress {
  return { step: 'mount', scanned: 0, hashed: 0, copied: 0, bytes: 0, total: 0 };
}

/**
 * One stored disk-import job. A scan creates it in `scanning`, fills in the
 * `plan` + `hashes` and flips to `reviewed`; the apply gate keys off this (a
 * plan can only be applied via a session that reached `reviewed` and was not
 * yet consumed). `plan`/`hashes` are absent while `scanning`. `hashes` is
 * serialized as a plain object (JSON has no Map).
 */
export interface ScanSession {
  id: string;
  device: string;
  /** Absent while the scan is still in flight (`scanning`). */
  plan?: ImportPlan;
  /** sourcePath → sha256 hex. Persisted as a plain object; rehydrated to a Map
   *  by `sessionHashes`. Absent while `scanning`. */
  hashes?: Record<string, string>;
  catalogPath: string;
  /**
   * The scan mountpoint (#1915). Stable per device (derived from the device
   * name), persisted so the apply re-plan can strip it to recover each record's
   * routing-tree-relative path. Absent while `scanning`.
   */
  mountpoint?: string;
  /** Box users that drive the review Owner picker (#1915). Absent while scanning. */
  boxUsers?: string[];
  /** The auto-assigned explicit rule map (exact-match owners) the scan seeded
   *  (#1915), keyed by relative dir. Lets a re-attaching card rebuild the tree
   *  with the same pre-assignments. Absent while scanning. */
  autoRules?: Record<string, Rule>;
  phase: SessionPhase;
  /** Live progress for the in-flight (or last) pass (#1897). */
  progress: SessionProgress;
  /** How many files the apply wrote/uploaded (set when `applied`). */
  applied?: number;
  /** Message of the throw that put the session in `error`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** PROCESS_STARTED_AT of the process that last wrote this session — the
   *  crash/restart breadcrumb. */
  seenBy: string;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true }).catch(() => undefined);
}

const statePath = (id: string) => path.join(SESSIONS_DIR, `${id}.json`);
const logPath = (id: string) => path.join(SESSIONS_DIR, `${id}.log`);

/**
 * Atomic write via tmp + rename. Prevents a reopened card (or the apply gate)
 * from ever reading a partially-written session file even if the process is
 * killed mid-write. Mirrors jobStore.atomicWrite.
 */
async function atomicWrite(p: string, content: string): Promise<void> {
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, p);
}

export interface CreateSessionInput {
  id: string;
  device: string;
  plan: ImportPlan;
  hashes: Map<string, string>;
  catalogPath: string;
}

/** Persist a freshly-reviewed scan (synchronous-scan path / direct create).
 *  Prunes old sessions first, then writes the state file atomically + an empty
 *  log file. The async flow uses {@link createScanJob} + {@link finalizeScan}
 *  instead; this remains for the simple "plan already in hand" case. */
export async function createSession(input: CreateSessionInput): Promise<ScanSession> {
  await ensureDir();
  await pruneSessions(KEEP_RECENT_SESSIONS);
  const now = new Date().toISOString();
  const session: ScanSession = {
    id: input.id,
    device: input.device,
    plan: input.plan,
    hashes: Object.fromEntries(input.hashes),
    catalogPath: input.catalogPath,
    phase: 'reviewed',
    progress: { ...emptyProgress(), step: 'done', scanned: input.plan.items.length },
    createdAt: now,
    updatedAt: now,
    seenBy: PROCESS_STARTED_AT,
  };
  await atomicWrite(statePath(session.id), JSON.stringify(session, null, 2));
  await fs.writeFile(logPath(session.id), '', 'utf-8').catch(() => undefined);
  return session;
}

/**
 * Open a new disk-import job in `scanning` (#1897). The scan route calls this
 * and returns the id IMMEDIATELY; the background scan then fills the plan via
 * {@link finalizeScan}. There is no plan/hashes yet, so the apply gate refuses
 * a `scanning` session. Prunes old sessions + opens an empty log file.
 */
export async function createScanJob(input: {
  id: string;
  device: string;
  catalogPath: string;
}): Promise<ScanSession> {
  await ensureDir();
  await pruneSessions(KEEP_RECENT_SESSIONS);
  const now = new Date().toISOString();
  const session: ScanSession = {
    id: input.id,
    device: input.device,
    catalogPath: input.catalogPath,
    phase: 'scanning',
    progress: emptyProgress(),
    createdAt: now,
    updatedAt: now,
    seenBy: PROCESS_STARTED_AT,
  };
  await atomicWrite(statePath(session.id), JSON.stringify(session, null, 2));
  await fs.writeFile(logPath(session.id), '', 'utf-8').catch(() => undefined);
  return session;
}

/**
 * Per-id write serialization. A background pass streams progress via
 * {@link setProgress} (fire-and-forget) AND ends with a terminal write
 * ({@link markApplied} / {@link finalizeScan}); both are read-modify-write on
 * the same state file, so without ordering a late progress write could clobber
 * the terminal phase back (e.g. `applied` → `applying`). Chaining every
 * `updateSession` for an id makes the last enqueued write win, deterministically.
 * Same shape as jobStore's `withCreateJobLock`.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function withSessionWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(id, next.catch(() => undefined));
  return next;
}

/** Generic patch of a session (best-effort disk write, mirrors jobStore.updateJob).
 *  Refreshes `updatedAt` + the restart breadcrumb. Returns null if it's gone.
 *  Serialized per id so a trailing progress tick can't clobber a terminal write. */
export async function updateSession(
  id: string,
  partial: Partial<Omit<ScanSession, 'id' | 'createdAt'>>,
): Promise<ScanSession | null> {
  return withSessionWriteLock(id, async () => {
    const current = await getSession(id);
    if (!current) return null;
    const next: ScanSession = {
      ...current,
      ...partial,
      updatedAt: new Date().toISOString(),
      seenBy: PROCESS_STARTED_AT,
    };
    try {
      await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
    } catch {
      // Disk write failed (volume gone? permissions?). The background pass keeps
      // running; worst case a restart loses progress for this job.
    }
    return next;
  });
}

/** Patch just the live progress counters of an in-flight pass (#1897). Routed
 *  through the per-id write lock — the read-modify-merge of `progress` happens
 *  INSIDE the lock so concurrent ticks (and the terminal markApplied) don't
 *  clobber each other. */
export async function setProgress(
  id: string,
  partial: Partial<SessionProgress>,
): Promise<void> {
  await withSessionWriteLock(id, async () => {
    const current = await getSession(id);
    if (!current) return;
    const next: ScanSession = {
      ...current,
      progress: { ...current.progress, ...partial },
      updatedAt: new Date().toISOString(),
      seenBy: PROCESS_STARTED_AT,
    };
    try {
      await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
    } catch {
      /* best-effort live progress; a lost tick is non-fatal */
    }
  });
}

/** Background scan completed: attach the reviewed plan + hashes and flip to
 *  `reviewed` so the apply gate accepts it. */
export async function finalizeScan(
  id: string,
  input: {
    plan: ImportPlan;
    hashes: Map<string, string>;
    mountpoint?: string;
    boxUsers?: string[];
    autoRules?: Record<string, Rule>;
  },
): Promise<ScanSession | null> {
  return updateSession(id, {
    plan: input.plan,
    hashes: Object.fromEntries(input.hashes),
    mountpoint: input.mountpoint,
    boxUsers: input.boxUsers,
    autoRules: input.autoRules,
    phase: 'reviewed',
    progress: {
      step: 'done',
      scanned: input.plan.items.length,
      hashed: input.plan.items.length,
      copied: 0,
      bytes: 0,
      total: input.plan.items.length,
    },
  });
}

/** Flip a reviewed session into `applying` (the apply background pass started). */
export async function markApplying(id: string): Promise<ScanSession | null> {
  return updateSession(id, { phase: 'applying', progress: { ...emptyProgress(), step: 'copy' } });
}

/** Record a background pass failure: phase=error + the message. */
export async function markError(id: string, message: string): Promise<ScanSession | null> {
  return updateSession(id, { phase: 'error', error: message });
}

/** Read a session by id. Returns null when the state file is missing or
 *  corrupt — a forged/replayed id can't conjure a plan (the review gate). */
export async function getSession(id: string): Promise<ScanSession | null> {
  try {
    const raw = await fs.readFile(statePath(id), 'utf-8');
    const parsed = JSON.parse(raw) as ScanSession;
    return parsed;
  } catch {
    return null;
  }
}

/** Convenience: rehydrate the persisted `hashes` object back to the Map the
 *  apply path works with. Empty for a session still `scanning`. */
export function sessionHashes(session: ScanSession): Map<string, string> {
  return new Map(Object.entries(session.hashes ?? {}));
}

/** Mark a session as applied (one apply per reviewed plan) and refresh its
 *  breadcrumb. `applied` is the count of files written this pass (surfaced by
 *  the status route when the card re-attaches to a finished apply). Returns
 *  null if the session is gone. */
export async function markApplied(id: string, appliedCount?: number): Promise<ScanSession | null> {
  const current = await getSession(id);
  // Routed through the per-id write lock so a trailing progress tick from the
  // apply pass can't clobber the terminal `applied` phase back to `applying`.
  // `step: 'done'` is the final progress; the count is what the card shows.
  return updateSession(id, {
    phase: 'applied',
    applied: appliedCount ?? current?.applied,
    progress: { ...(current?.progress ?? emptyProgress()), step: 'done' },
  });
}

/** Append a line to a session's log file. Best-effort, for #1897's progress
 *  stream to build on. */
export async function appendLog(id: string, line: string): Promise<void> {
  await fs.appendFile(logPath(id), line + '\n', 'utf-8').catch(() => undefined);
}

/** Read a session's log from `sinceBytes` to end-of-file, so a reattaching
 *  card can catch up. Mirrors jobStore.readLog. */
export async function readLog(
  id: string,
  sinceBytes: number = 0,
): Promise<{ content: string; nextOffset: number }> {
  try {
    const stat = await fs.stat(logPath(id));
    if (sinceBytes >= stat.size) return { content: '', nextOffset: stat.size };
    const fh = await fs.open(logPath(id), 'r');
    try {
      const buf = Buffer.alloc(stat.size - sinceBytes);
      await fh.read(buf, 0, buf.length, sinceBytes);
      return { content: buf.toString('utf-8'), nextOffset: stat.size };
    } finally {
      await fh.close();
    }
  } catch {
    return { content: '', nextOffset: 0 };
  }
}

/**
 * Any session left mid-flight (`scanning`/`applying`) belonged to a previous
 * backend process that died — flip it to `error` so a reopened card surfaces a
 * "try again" instead of polling forever for progress that will never come.
 * Mirrors jobStore.markCrashedOnStartup. Returns how many it flipped.
 */
export async function markCrashedOnStartup(): Promise<number> {
  const sessions = await listSessions();
  let count = 0;
  for (const s of sessions) {
    if (s.phase === 'scanning' || s.phase === 'applying') {
      await updateSession(s.id, {
        phase: 'error',
        error: 'Backend restarted while the disk-import job was running.',
      });
      count += 1;
    }
  }
  return count;
}

export async function listSessions(): Promise<ScanSession[]> {
  try {
    await ensureDir();
    const entries = await fs.readdir(SESSIONS_DIR);
    const sessions: ScanSession[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(SESSIONS_DIR, f), 'utf-8');
        sessions.push(JSON.parse(raw) as ScanSession);
      } catch {
        /* skip corrupt files */
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

async function pruneSessions(keep: number): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length <= keep) return;
  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const s of sessions.slice(keep)) {
    await fs.unlink(statePath(s.id)).catch(() => undefined);
    await fs.unlink(logPath(s.id)).catch(() => undefined);
  }
}

/** Test seam: wipe the on-disk session store. */
export async function __clearSessions(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true }).catch(() => undefined);
}
