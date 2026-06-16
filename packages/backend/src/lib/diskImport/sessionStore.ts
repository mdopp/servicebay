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

import type { ImportPlan } from './types';

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

export type SessionPhase = 'reviewed' | 'applied';

/**
 * One stored, reviewed scan. The apply gate keys off this: a plan can only be
 * applied via a session that was scanned + reviewed (persisted here) and not
 * yet consumed. `hashes` is serialized as a plain object (JSON has no Map).
 */
export interface ScanSession {
  id: string;
  device: string;
  plan: ImportPlan;
  /** sourcePath → sha256 hex. Persisted as a plain object; rehydrated to a Map
   *  by `getSession`. */
  hashes: Record<string, string>;
  catalogPath: string;
  phase: SessionPhase;
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

/** Persist a freshly-reviewed scan. Prunes old sessions first, then writes the
 *  state file atomically + an empty log file. */
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
    createdAt: now,
    updatedAt: now,
    seenBy: PROCESS_STARTED_AT,
  };
  await atomicWrite(statePath(session.id), JSON.stringify(session, null, 2));
  await fs.writeFile(logPath(session.id), '', 'utf-8').catch(() => undefined);
  return session;
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
 *  apply path works with. */
export function sessionHashes(session: ScanSession): Map<string, string> {
  return new Map(Object.entries(session.hashes));
}

/** Mark a session as applied (one apply per reviewed plan) and refresh its
 *  breadcrumb. Returns null if the session is gone. */
export async function markApplied(id: string): Promise<ScanSession | null> {
  const current = await getSession(id);
  if (!current) return null;
  const next: ScanSession = {
    ...current,
    phase: 'applied',
    updatedAt: new Date().toISOString(),
    seenBy: PROCESS_STARTED_AT,
  };
  try {
    await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
  } catch {
    // Disk write failed (volume gone? permissions?). The apply already
    // succeeded; worst case a restart re-offers an applied session — the
    // catalog dedup makes a re-apply a no-op, so this is non-fatal.
  }
  return next;
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

async function listSessions(): Promise<ScanSession[]> {
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
