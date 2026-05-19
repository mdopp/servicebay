/**
 * File-based persistence for install jobs.
 *
 * Why this exists: the deploy loop used to live in the browser, which
 * meant closing the tab mid-install left the server with a half-deployed
 * stack and no way for a reopened tab to pick up where it left off. The
 * loop now runs in the Next.js process via `runner.ts`; this module
 * persists state + log output so:
 *
 *   - a reopened browser tab can attach to a running install
 *   - the singleton "is an install running?" check survives across
 *     pages, devices, and Claude MCP sessions
 *   - a server crash leaves a breadcrumb (markCrashedOnStartup)
 *
 * Replaces `wizard/installLock.ts`. Each job has its own state file
 * (atomic write) and an append-only log file. State files are tiny
 * (<10KB) so a full read/write per update is fine — this is not a
 * hot path.
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';

const JOBS_DIR = path.join(DATA_DIR, 'install-jobs');

/** Captured at module load — effectively the current server process's
 *  start time. Used by /api/install/status to distinguish a terminal
 *  job that belongs to this server instance from one that's left over
 *  on disk from a previous boot (e.g. after an OS re-install where
 *  the install-jobs dir survives on the RAID mount but the jobs it
 *  contains reference a long-gone server process). */
export const PROCESS_STARTED_AT = new Date().toISOString();

/** Pruning threshold — keep this many most-recent jobs on disk so the
 *  /api/install/status route can fetch a finished job's logs after the
 *  Done step lands. Older jobs get cleaned up on each createJob call. */
const KEEP_RECENT_JOBS = 20;

export type JobPhase =
  | 'running'
  | 'needs_credentials'
  | 'done'
  | 'error'
  | 'aborted'
  | 'crashed';

/** Persisted shape of a single template within the job input. The
 *  runner re-renders this with Mustache against `JobInput.variables`,
 *  so the yaml/configFiles must still contain `{{VAR}}` placeholders. */
export interface JobInputItem {
  name: string;
  checked: boolean;
  alreadyInstalled?: boolean;
  yaml?: string;
  configFiles?: { filename: string; content: string; targetPath?: string }[];
  dependencies?: string[];
}

/** Persisted variable shape. `meta` is intentionally `unknown` — only
 *  consumers re-type it when reading (see `meta?.oidcClient` access in
 *  the Authelia capability handler). The type system isn't load-bearing here. */
export interface JobInputVariable {
  name: string;
  value: string;
  global?: boolean;
  meta?: unknown;
}

export interface JobInput {
  items: JobInputItem[];
  variables: JobInputVariable[];
  node?: string;
  cleanInstall: boolean;
  cleanInstallConfirm: string;
  /** Per-group preserve flags for the clean-install wipe (#568). Each
   *  entry the operator left checked means "keep this group". Maps to
   *  `ResetGroup` from `@/lib/install/resetGroups`. Omitted = use the
   *  API default (keep system-critical: secrets + certs + identity). */
  preserve?: string[];
  templateSource: string;
  /** `window.location.hostname` captured client-side so the credentials
   *  banner can render reachable URLs without the server having to guess. */
  host: string;
}

export interface JobState {
  id: string;
  source: string;
  phase: JobPhase;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  input: JobInput;
  progress: {
    currentItem: string | null;
    deployedNames: string[];
    totalCount: number;
  };
  error?: string;
  credentialsManifest?: Credential[];
  /** Set when the runner pauses on the NPM credentials prompt. The
   *  client reads `fallback` to pre-fill the prompt UI. */
  needsCredentials?: {
    fallback: { email: string; password: string };
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(JOBS_DIR, { recursive: true }).catch(() => undefined);
}

const statePath = (id: string) => path.join(JOBS_DIR, `${id}.json`);
const logPath = (id: string) => path.join(JOBS_DIR, `${id}.log`);

/** In-memory cache of every job created this process. Survives a
 *  vanishing on-disk state file (#705): the reset endpoint used to
 *  wipe `/mnt/data/servicebay/install-jobs/` along with the rest of
 *  the secrets group, dropping the state-json out from under the
 *  runner mid-install. The next \`updateJob\` couldn't find it,
 *  silently bailed, and the wizard's progress poll returned null
 *  for the rest of the run. The cache lets \`updateJob\` rewrite
 *  the disk file from in-memory state when that happens. */
const memCache = new Map<string, JobState>();

/** Atomic write via tmp + rename. Prevents readers from ever seeing a
 *  partially-written state file even if the process is killed mid-write. */
async function atomicWrite(p: string, content: string): Promise<void> {
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, p);
}

export async function createJob(opts: { source: string; input: JobInput }): Promise<JobState> {
  await ensureDir();
  await pruneJobs(KEEP_RECENT_JOBS);
  const now = new Date().toISOString();
  const job: JobState = {
    id: randomUUID(),
    source: opts.source,
    phase: 'running',
    startedAt: now,
    updatedAt: now,
    input: opts.input,
    progress: {
      currentItem: null,
      deployedNames: [],
      totalCount: opts.input.items.filter(i => i.checked).length,
    },
  };
  await atomicWrite(statePath(job.id), JSON.stringify(job, null, 2));
  await fs.writeFile(logPath(job.id), '', 'utf-8');
  memCache.set(job.id, job);
  return job;
}

export async function getJob(id: string): Promise<JobState | null> {
  try {
    const raw = await fs.readFile(statePath(id), 'utf-8');
    const parsed = JSON.parse(raw) as JobState;
    // Refresh memory cache from disk on every read so server-restart
    // gets stale-but-correct state until the next update writes back.
    memCache.set(id, parsed);
    return parsed;
  } catch {
    // Fall back to memory cache when the disk file is missing or
    // corrupt — see #705. Returning null silently used to strand the
    // wizard's status poll.
    return memCache.get(id) ?? null;
  }
}

export async function updateJob(
  id: string,
  partial: Partial<Omit<JobState, 'id' | 'startedAt' | 'input'>>,
): Promise<JobState | null> {
  const current = await getJob(id);
  if (!current) return null;
  const next: JobState = { ...current, ...partial, updatedAt: new Date().toISOString() };
  // Best-effort disk write. The memory cache is the authoritative
  // store within this process; disk is for status-route reads + post-
  // restart recovery (#705).
  try {
    await atomicWrite(statePath(id), JSON.stringify(next, null, 2));
  } catch {
    // Disk write failed (volume gone? permissions?). Cache still has
    // the new state, status route reads from cache, runner keeps
    // going. Worst case: a restart loses progress for this job, but
    // the install itself continues.
  }
  memCache.set(id, next);
  return next;
}

export async function appendLog(id: string, line: string): Promise<void> {
  await fs.appendFile(logPath(id), line + '\n', 'utf-8').catch(() => undefined);
}

/** Read log content from `sinceBytes` to end-of-file. Used by the
 *  /api/install/status route so a reattaching client can catch up on
 *  log lines emitted while it was disconnected. */
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

async function listJobs(): Promise<JobState[]> {
  try {
    await ensureDir();
    const entries = await fs.readdir(JOBS_DIR);
    const jobs: JobState[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), 'utf-8');
        jobs.push(JSON.parse(raw) as JobState);
      } catch { /* skip corrupt files */ }
    }
    return jobs;
  } catch {
    return [];
  }
}

/**
 * "Has there been recent install activity?" — true if a job is
 * currently running OR the most-recent terminal job ended less than
 * `graceMs` milliseconds ago. Used by diagnose probes (e.g.
 * crash_loop) to soften "container is too young → must be restarting"
 * heuristics that would otherwise fire on freshly-deployed services
 * the moment the install finishes. Cheap (one disk scan); callers
 * are usually rare (one probe run per diagnose), so we don't cache.
 */
export async function wasInstallActiveWithin(graceMs: number): Promise<boolean> {
  const jobs = await listJobs();
  if (jobs.length === 0) return false;
  const now = Date.now();
  for (const j of jobs) {
    if (j.phase === 'running' || j.phase === 'needs_credentials') return true;
    const ended = j.endedAt ? Date.parse(j.endedAt) : Date.parse(j.updatedAt);
    if (Number.isFinite(ended) && now - ended < graceMs) return true;
  }
  return false;
}

/**
 * Most-recent job in *any* phase, sorted by start time. Used by the
 * UI to decide whether to show "Setup" affordances after an install
 * has finished — `getCurrentJob` filters to active phases only, so a
 * job that's already `done` is invisible to it. Returns `null` only
 * when no jobs have ever been recorded.
 */
export async function getLatestJob(): Promise<JobState | null> {
  const jobs = await listJobs();
  if (jobs.length === 0) return null;
  jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return jobs[0];
}

/** Singleton "is an install in progress?" check. Returns the most
 *  recent job in an active phase, or null. Replaces installLock.ts. */
export async function getCurrentJob(): Promise<JobState | null> {
  const jobs = await listJobs();
  const active = jobs
    .filter(j => j.phase === 'running' || j.phase === 'needs_credentials')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return active[0] ?? null;
}

/** Called once from server.ts on startup. Any job left in an active
 *  phase belonged to a previous server process that died mid-install
 *  — flip it to `crashed` so the UI can surface a Start-over button
 *  instead of polling forever for an update that will never come. */
export async function markCrashedOnStartup(): Promise<number> {
  const jobs = await listJobs();
  let count = 0;
  for (const j of jobs) {
    if (j.phase === 'running' || j.phase === 'needs_credentials') {
      await updateJob(j.id, {
        phase: 'crashed',
        endedAt: new Date().toISOString(),
        error: 'Server restarted while install was in progress.',
      });
      count++;
    }
  }
  return count;
}

async function pruneJobs(keep: number): Promise<void> {
  const jobs = await listJobs();
  if (jobs.length <= keep) return;
  jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const j of jobs.slice(keep)) {
    // Don't prune active jobs even if they're somehow ranked low.
    if (j.phase === 'running' || j.phase === 'needs_credentials') continue;
    await fs.unlink(statePath(j.id)).catch(() => undefined);
    await fs.unlink(logPath(j.id)).catch(() => undefined);
  }
}
