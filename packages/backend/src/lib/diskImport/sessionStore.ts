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
 * This module persists each session under DATA_DIR, modeled on
 * `lib/install/jobStore.ts`:
 *
 *   - a reopened card can re-attach to a reviewed plan by session id
 *   - the reviewed plan + apply reference survive a backend restart
 *   - a crash leaves a breadcrumb (PROCESS_STARTED_AT)
 *
 * STORE SPLIT (#1945). At 177k files the inline plan + hashes is a ~145MB
 * monolithic JSON; rewriting it on every progress tick was O(N) per tick and
 * the status poll shipped the whole blob → the card couldn't load it and fell
 * back to 'Starting…'. The session is now TWO files:
 *
 *   - `<id>.json`       — the COMPACT status doc: phase, progress, dedup
 *                         counters, heartbeat, and a small derived `summary`
 *                         (counts + routing tree the card renders). KBs–low MBs.
 *                         Rewritten on every progress tick.
 *   - `<id>.plan.json`  — the BULK sidecar: `{ plan, hashes }` (all records
 *                         inline). Written ONCE at finalize/finalize-dedup,
 *                         read ONLY at apply. Never touched by progress ticks
 *                         or the status poll.
 *
 * The status route uses {@link getSessionStatus} (reads only the compact doc);
 * the apply path uses {@link getSession} (rehydrates plan+hashes from the
 * sidecar). The `ScanSession` shape is unchanged for callers.
 *
 * LIVENESS (#1943). A scan whose worker process is killed (restart/crash before
 * the error handler runs) used to sit at a non-terminal phase forever — the
 * card re-attached and showed 'Starting…' with no way to dismiss it. Progress
 * writes now stamp a `heartbeat`; a non-terminal session whose heartbeat is
 * older than {@link STALE_AFTER_MS} is reaped to `error` on backend start AND
 * on every status read, and {@link abortSession} lets the card dismiss a stuck
 * session and start fresh.
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
 * Liveness threshold (#1943). A non-terminal session whose `heartbeat` (or, for
 * a session that never ticked, `updatedAt`) is older than this is treated as a
 * dead worker and reaped to `error`. A scan's host walk/hash ticks progress far
 * more often than this; the window is generous enough that a slow-but-alive pass
 * is never falsely reaped.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Largest routing tree the compact status doc carries (#1945). The tree is one
 * node per directory (not per file), so it's far smaller than the records, but a
 * pathological disk with hundreds of thousands of dirs could still bloat the
 * status payload — cap it so the card always loads fast. The per-category table
 * + totals still reflect the full scan; only the per-folder tree is truncated.
 */
export const MAX_TREE_NODES = 2000;

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

/**
 * Dedup sub-state (#1937). The scan now flips to `reviewed` on METADATA ONLY (so
 * the routing tree renders in seconds), then hashes the size-collision candidates
 * in the BACKGROUND to fill in skip-dupe decisions. This tracks that background
 * pass so the card can show a non-blocking "checking duplicates…" secondary line
 * WITHOUT gating the already-rendered tree:
 *
 *   pending  → reviewed, the background hash/dedup pass hasn't started yet
 *   running  → hashing candidates now (progress.hashed/total advance)
 *   done     → dedup complete; the plan's skip-dupe decisions are final
 *   partial  → dedup finished but some files couldn't be hashed (skipped, #1937
 *              Part B) — they're imported un-deduped (safe; apply re-dedups)
 *
 * A scan with no size-collision candidates (nothing to hash) is `done`
 * immediately. Absent on pre-#1937 sessions → the card treats that as `done`.
 */
export type DedupState = 'pending' | 'running' | 'done' | 'partial';

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
 * The COMPACT review summary the card renders (#1945). Derived once from the
 * plan at finalize/finalize-dedup time and persisted on the status doc so the
 * status poll never has to load the 145MB record set. The bulk records live in
 * the sidecar (read only at apply). This is a plain-data subset — `categories`/
 * `tree`/`actions` are pre-rendered by `service.ts` (the engine layer), so the
 * store stays engine-agnostic. The `tree` is capped to {@link MAX_TREE_NODES}.
 */
export interface ReviewSummary {
  totalFiles: number;
  totalBytes: number;
  /** Per-category rollup (one row per Category). */
  categories: unknown[];
  /** Non-blocking, advisory review actions[] (ambiguous folders / conflicts). */
  actions: unknown[];
  /** Per-folder routing tree (one node per directory), capped. */
  tree: unknown[];
  /** True when {@link tree} was truncated past {@link MAX_TREE_NODES}. */
  treeTruncated?: boolean;
  /** Box users that drive the Owner picker. */
  boxUsers: string[];
  /** The disk-default owner seeding the tree root. */
  defaultOwner: string;
}

/** The bulk sidecar (#1945): the full plan + hashes, written once and read only
 *  at apply. Kept OUT of the compact status doc so progress ticks + the status
 *  poll never touch it. */
interface PlanSidecar {
  plan: ImportPlan;
  /** sourcePath → sha256 hex. Persisted as a plain object (JSON has no Map). */
  hashes: Record<string, string>;
}

/**
 * One stored disk-import job. A scan creates it in `scanning`, fills in the
 * `plan` + `hashes` (in the sidecar) and flips to `reviewed`; the apply gate
 * keys off this (a plan can only be applied via a session that reached
 * `reviewed` and was not yet consumed). `plan`/`hashes` are absent while
 * `scanning`, and are loaded from the sidecar by {@link getSession} (the status
 * poll uses {@link getSessionStatus}, which leaves them undefined). `hashes` is
 * serialized as a plain object (JSON has no Map).
 */
export interface ScanSession {
  id: string;
  device: string;
  /** Absent while the scan is still in flight (`scanning`), and absent on a
   *  {@link getSessionStatus} read (the status poll never loads the sidecar). */
  plan?: ImportPlan;
  /** sourcePath → sha256 hex. Persisted in the sidecar; rehydrated to a Map by
   *  `sessionHashes`. Absent while `scanning` / on a status-only read. */
  hashes?: Record<string, string>;
  /** The COMPACT review summary the card renders (#1945). Present once
   *  `reviewed`; on the status doc, not the sidecar. */
  summary?: ReviewSummary;
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
  /**
   * Background-dedup sub-state (#1937). Present once the scan reaches `reviewed`
   * on metadata only; the background hash pass advances it pending → running →
   * done/partial. Absent on pre-#1937 sessions (treat as `done`). The
   * `dedupProgress` pair drives the card's "checking duplicates… N / M" line.
   */
  dedup?: DedupState;
  /** How many candidate files have been hashed in the background dedup pass so
   *  far (#1937), and the total candidate count. Both 0 when there's nothing to
   *  hash. Separate from `progress` so the card can show dedup advancing while
   *  the (already-rendered) tree's `progress.step` stays `done`. */
  dedupHashed?: number;
  dedupTotal?: number;
  /** Live progress for the in-flight (or last) pass (#1897). */
  progress: SessionProgress;
  /** How many files the apply wrote/uploaded (set when `applied`). */
  applied?: number;
  /** Message of the throw that put the session in `error`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Liveness breadcrumb (#1943): refreshed by every progress tick of an
   *  in-flight pass. A non-terminal session whose `heartbeat` is older than
   *  {@link STALE_AFTER_MS} is reaped to `error` (dead worker). Absent on
   *  pre-#1943 sessions → `updatedAt` is the fallback. */
  heartbeat?: string;
  /** PROCESS_STARTED_AT of the process that last wrote this session — the
   *  crash/restart breadcrumb. */
  seenBy: string;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true }).catch(() => undefined);
}

const statePath = (id: string) => path.join(SESSIONS_DIR, `${id}.json`);
const planPath = (id: string) => path.join(SESSIONS_DIR, `${id}.plan.json`);
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

/** Write the bulk plan+hashes sidecar (#1945). Once per finalize/finalize-dedup;
 *  never on a progress tick. Atomic so a mid-write kill never leaves a partial
 *  sidecar an apply could read. */
async function writePlanSidecar(id: string, plan: ImportPlan, hashes: Map<string, string>): Promise<void> {
  const sidecar: PlanSidecar = { plan, hashes: Object.fromEntries(hashes) };
  await atomicWrite(planPath(id), JSON.stringify(sidecar));
}

/** Read the bulk plan+hashes sidecar (#1945). Returns null when absent (a
 *  `scanning` session, or a pre-split session that never wrote one). */
async function readPlanSidecar(id: string): Promise<PlanSidecar | null> {
  try {
    return JSON.parse(await fs.readFile(planPath(id), 'utf-8')) as PlanSidecar;
  } catch {
    return null;
  }
}

/** Truncate a routing tree to {@link MAX_TREE_NODES} for the compact status doc
 *  (#1945). Returns the (possibly truncated) tree + whether it was cut. */
function capTree(tree: unknown[]): { tree: unknown[]; truncated: boolean } {
  if (tree.length <= MAX_TREE_NODES) return { tree, truncated: false };
  return { tree: tree.slice(0, MAX_TREE_NODES), truncated: true };
}

export interface CreateSessionInput {
  id: string;
  device: string;
  plan: ImportPlan;
  hashes: Map<string, string>;
  catalogPath: string;
  /** Pre-rendered compact review summary (#1945). Optional for the synchronous /
   *  test path; the status poll just has no tree until a summary is supplied. */
  summary?: ReviewSummary;
}

/** Persist a freshly-reviewed scan (synchronous-scan path / direct create).
 *  Prunes old sessions first, then writes the compact state file + the bulk
 *  plan sidecar (#1945) atomically + an empty log file. The async flow uses
 *  {@link createScanJob} + {@link finalizeScan} instead; this remains for the
 *  simple "plan already in hand" case. */
export async function createSession(input: CreateSessionInput): Promise<ScanSession> {
  await ensureDir();
  await pruneSessions(KEEP_RECENT_SESSIONS);
  const now = new Date().toISOString();
  const status: ScanSession = {
    id: input.id,
    device: input.device,
    summary: input.summary,
    catalogPath: input.catalogPath,
    phase: 'reviewed',
    progress: { ...emptyProgress(), step: 'done', scanned: input.plan.items.length },
    createdAt: now,
    updatedAt: now,
    heartbeat: now,
    seenBy: PROCESS_STARTED_AT,
  };
  await writePlanSidecar(input.id, input.plan, input.hashes);
  await atomicWrite(statePath(input.id), JSON.stringify(status, null, 2));
  await fs.writeFile(logPath(input.id), '', 'utf-8').catch(() => undefined);
  // Return the rehydrated full session (plan+hashes inline) for the caller.
  return { ...status, plan: input.plan, hashes: Object.fromEntries(input.hashes) };
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
    heartbeat: now,
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

/** Read just the COMPACT status doc (#1945) — phase, progress, dedup counters,
 *  heartbeat, summary. Does NOT load the bulk plan/hashes sidecar, so this stays
 *  cheap even for a 177k-file scan. The status poll path. Returns null when the
 *  state file is missing or corrupt. */
async function readStatusDoc(id: string): Promise<ScanSession | null> {
  try {
    return JSON.parse(await fs.readFile(statePath(id), 'utf-8')) as ScanSession;
  } catch {
    return null;
  }
}

/** Generic patch of the COMPACT status doc (#1945). Refreshes `updatedAt` + the
 *  restart breadcrumb. Returns null if it's gone. Serialized per id so a
 *  trailing progress tick can't clobber a terminal write. NEVER touches the
 *  plan sidecar — bulk writes go through {@link writePlanSidecar}. */
export async function updateSession(
  id: string,
  partial: Partial<Omit<ScanSession, 'id' | 'createdAt'>>,
): Promise<ScanSession | null> {
  return withSessionWriteLock(id, async () => {
    const current = await readStatusDoc(id);
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
 *  clobber each other. Refreshes the liveness `heartbeat` (#1943) so a running
 *  pass is never reaped as stale. Writes ONLY the compact status doc. */
export async function setProgress(
  id: string,
  partial: Partial<SessionProgress>,
): Promise<void> {
  await withSessionWriteLock(id, async () => {
    const current = await readStatusDoc(id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: ScanSession = {
      ...current,
      progress: { ...current.progress, ...partial },
      updatedAt: now,
      heartbeat: now,
      seenBy: PROCESS_STARTED_AT,
    };
    try {
      await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
    } catch {
      /* best-effort live progress; a lost tick is non-fatal */
    }
  });
}

/** Background scan completed: write the bulk plan + hashes to the sidecar
 *  (#1945) and flip the compact status doc to `reviewed` with the derived
 *  `summary`, so the apply gate accepts it and the card renders the tree without
 *  loading the records.
 *
 *  Review-first (#1937): the scan finalizes on METADATA ONLY (no hashes yet)
 *  with `dedup: 'pending'` so the tree renders immediately; the background hash
 *  pass then re-finalizes via {@link finalizeDedup}. A scan with nothing to dedup
 *  passes `dedup: 'done'`. `hashes` is whatever's known so far (empty for the
 *  metadata-only finalize). */
export async function finalizeScan(
  id: string,
  input: {
    plan: ImportPlan;
    hashes: Map<string, string>;
    mountpoint?: string;
    boxUsers?: string[];
    autoRules?: Record<string, Rule>;
    dedup?: DedupState;
    dedupTotal?: number;
    /** The compact review summary (#1945) — counts + capped tree the card renders. */
    summary?: ReviewSummary;
  },
): Promise<ScanSession | null> {
  const dedup = input.dedup ?? 'done';
  await writePlanSidecar(id, input.plan, input.hashes);
  const summary = input.summary ? capSummaryTree(input.summary) : undefined;
  return updateSession(id, {
    summary,
    mountpoint: input.mountpoint,
    boxUsers: input.boxUsers,
    autoRules: input.autoRules,
    phase: 'reviewed',
    dedup,
    dedupHashed: 0,
    dedupTotal: input.dedupTotal ?? 0,
    heartbeat: new Date().toISOString(),
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

/** Apply the {@link MAX_TREE_NODES} cap to a summary's tree (#1945). */
function capSummaryTree(summary: ReviewSummary): ReviewSummary {
  const { tree, truncated } = capTree(summary.tree);
  return truncated ? { ...summary, tree, treeTruncated: true } : summary;
}

/** Flip a `reviewed` session's dedup sub-state to `running` (the background hash
 *  pass started, #1937). The tree stays rendered; only the secondary
 *  "checking duplicates…" line changes. Refreshes the heartbeat (#1943). */
export async function startDedup(id: string, total: number): Promise<ScanSession | null> {
  return updateSession(id, {
    dedup: 'running',
    dedupHashed: 0,
    dedupTotal: total,
    heartbeat: new Date().toISOString(),
  });
}

/** Live progress of the background dedup hash pass (#1937). Best-effort, like
 *  {@link setProgress}; a lost tick is non-fatal. Refreshes the heartbeat
 *  (#1943) and writes ONLY the compact status doc. */
export async function setDedupProgress(id: string, hashed: number, total: number): Promise<void> {
  await withSessionWriteLock(id, async () => {
    const current = await readStatusDoc(id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: ScanSession = {
      ...current,
      dedupHashed: hashed,
      dedupTotal: total,
      updatedAt: now,
      heartbeat: now,
      seenBy: PROCESS_STARTED_AT,
    };
    try {
      await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
    } catch {
      /* best-effort live dedup progress */
    }
  });
}

/** Background dedup pass completed (#1937): replace the metadata-only plan with
 *  the re-deduped plan + the resolved hashes (in the sidecar, #1945), refresh the
 *  compact `summary` (skip-dupe counts changed), and mark `done` (all candidates
 *  hashed) or `partial` (some files were un-hashable → imported un-deduped).
 *  Stays `reviewed` — this never gates apply, which re-dedups at the catalog. */
export async function finalizeDedup(
  id: string,
  input: { plan: ImportPlan; hashes: Map<string, string>; state: DedupState; summary?: ReviewSummary },
): Promise<ScanSession | null> {
  await writePlanSidecar(id, input.plan, input.hashes);
  return updateSession(id, {
    ...(input.summary ? { summary: capSummaryTree(input.summary) } : {}),
    dedup: input.state,
    heartbeat: new Date().toISOString(),
  });
}

/** Mark a session's background dedup pass as `partial` without touching the plan
 *  (#1937) — used when the whole dedup pass threw. The metadata-only plan stays
 *  (everything `copy`/un-deduped); apply re-dedups at the catalog. */
export async function markDedupPartial(id: string): Promise<ScanSession | null> {
  return updateSession(id, { dedup: 'partial' });
}

/** Flip a reviewed session into `applying` (the apply background pass started). */
export async function markApplying(id: string): Promise<ScanSession | null> {
  return updateSession(id, {
    phase: 'applying',
    progress: { ...emptyProgress(), step: 'copy' },
    heartbeat: new Date().toISOString(),
  });
}

/** Record a background pass failure: phase=error + the message. */
export async function markError(id: string, message: string): Promise<ScanSession | null> {
  return updateSession(id, { phase: 'error', error: message });
}

/**
 * Abort/dismiss a session (#1943). The card's "Start over" — flips a stuck or
 * unwanted session terminal so it stops re-attaching and the user can begin a
 * fresh scan. No-op-safe on a missing id (returns null) and idempotent on an
 * already-terminal session. Marks `error` with a dismissed message rather than
 * deleting, so the card can show "cancelled" rather than a bare disappearance.
 */
export async function abortSession(id: string): Promise<ScanSession | null> {
  const current = await readStatusDoc(id);
  if (!current) return null;
  if (current.phase === 'applied' || current.phase === 'error') return current;
  return updateSession(id, { phase: 'error', error: 'Cancelled — start a new scan when ready.' });
}

/** True when a non-terminal session's heartbeat (or updatedAt fallback) is older
 *  than {@link STALE_AFTER_MS} — its worker is presumed dead (#1943). */
function isStale(s: ScanSession, nowMs: number): boolean {
  const terminal = s.phase === 'reviewed' || s.phase === 'applied' || s.phase === 'error';
  if (terminal) return false;
  const last = Date.parse(s.heartbeat ?? s.updatedAt);
  if (Number.isNaN(last)) return false;
  return nowMs - last > STALE_AFTER_MS;
}

/**
 * Read a session by id (#1896), rehydrating the bulk plan + hashes from the
 * sidecar (#1945) so the apply path gets a complete {@link ScanSession}. Reaps a
 * stale non-terminal session to `error` first (#1943) so a re-attaching card
 * never sees a dead worker as 'Starting…'. Returns null when the state file is
 * missing or corrupt — a forged/replayed id can't conjure a plan (the review
 * gate).
 */
export async function getSession(id: string): Promise<ScanSession | null> {
  const status = await readStatusDoc(id);
  if (!status) return null;
  const live = isStale(status, Date.now())
    ? (await markStale(id)) ?? status
    : status;
  const sidecar = await readPlanSidecar(id);
  if (sidecar) {
    return { ...live, plan: sidecar.plan, hashes: sidecar.hashes };
  }
  return live;
}

/**
 * Read ONLY the compact status doc (#1945) — phase, progress, dedup counters,
 * the derived review `summary`, error. Does NOT load the bulk plan/hashes, so
 * the status poll stays small even for a 177k-file scan. Reaps a stale session
 * (#1943) on read. The status route uses this; the apply path uses
 * {@link getSession}. Returns null on a missing/corrupt id.
 */
export async function getSessionStatus(id: string): Promise<ScanSession | null> {
  const status = await readStatusDoc(id);
  if (!status) return null;
  return isStale(status, Date.now()) ? (await markStale(id)) ?? status : status;
}

/** Reap one stale session to `error` (#1943). */
async function markStale(id: string): Promise<ScanSession | null> {
  return updateSession(id, {
    phase: 'error',
    error: 'Scan interrupted — please retry.',
  });
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
  const current = await readStatusDoc(id);
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
 * "try again" instead of polling forever for progress that will never come
 * (#1943). Also reaps any session whose heartbeat is already stale (belt-and-
 * suspenders for a same-process zombie). Mirrors jobStore.markCrashedOnStartup.
 * Returns how many it flipped.
 */
export async function markCrashedOnStartup(): Promise<number> {
  const sessions = await listSessions();
  const nowMs = Date.now();
  let count = 0;
  for (const s of sessions) {
    if (s.phase === 'scanning' || s.phase === 'applying') {
      await updateSession(s.id, {
        phase: 'error',
        error: 'Backend restarted while the disk-import job was running.',
      });
      count += 1;
    } else if (isStale(s, nowMs)) {
      await markStale(s.id);
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
      // Only the compact status docs — skip the `.plan.json` sidecars (#1945)
      // and the `.log` files.
      if (!f.endsWith('.json') || f.endsWith('.plan.json')) continue;
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
    await fs.unlink(planPath(s.id)).catch(() => undefined);
    await fs.unlink(logPath(s.id)).catch(() => undefined);
  }
}

/** Test seam: wipe the on-disk session store. */
export async function __clearSessions(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true }).catch(() => undefined);
}
