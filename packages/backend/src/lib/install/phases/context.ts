/**
 * Shared runtime for the install-runner phase modules (#2742).
 *
 * `runner.ts` used to carry the whole job — every phase plus the plumbing
 * each phase needs. The phases now live in sibling modules under this
 * directory and `runner.ts` keeps only the ordering and the job status, so
 * the three things every phase reaches for — the job log, the job patch, and
 * the abort flag — have to live somewhere both sides can see. That is this
 * file. It owns no phase logic of its own.
 *
 * The abort flag is deliberately module-level state keyed by jobId, exactly
 * as it was in `runner.ts`: it does not survive a server restart by design
 * (any job in an active phase at startup is flipped to `crashed` by
 * `jobStore.markCrashedOnStartup()`).
 */
import { getInternalApiToken } from '@/lib/auth/internalToken';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';
import {
  appendLog,
  getJob,
  updateJob,
  type JobInput,
  type JobState,
} from '../jobStore';
import { emitJobLog, emitJobUpdate } from '../socketBridge';

/** The per-run state the deploy phases read and append to. */
export interface DeployContext {
  jobId: string;
  input: JobInput;
  scriptCredentials: Credential[];
  deployed: { name: string }[];
  reusedSecretNames: Set<string>;
}

/** Set by `abortJob`. Checked at top of every deploy-loop iteration and
 *  before each retry attempt so the loop bails out as soon as possible. */
const abortFlags = new Map<string, boolean>();

/** Raise the abort flag for a job. */
export function markJobAborted(jobId: string): void {
  abortFlags.set(jobId, true);
}

/** True once `abortJob` has been called for this run. */
export function isJobAborted(jobId: string): boolean {
  return abortFlags.get(jobId) === true;
}

/** Drop the flag — at the start of a run, and again when it finishes. */
export function clearJobAbortFlag(jobId: string): void {
  abortFlags.delete(jobId);
}

/** Render a byte count as a short user-readable string ("1.2 GB",
 *  "240 MB"). Used by the image-pull progress lines (#805). Powers
 *  of 1024 because that's how podman reports image sizes. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Loopback fetch helper. proxy.ts middleware gates state-changing API
 *  calls on either a session cookie OR the X-SB-Internal-Token header
 *  (the same token the post-deploy scripts on the agent host use). The
 *  runner has no session, so we attach the token here — without it
 *  every POST /api/services / NPM / portal call from this process gets
 *  403'd by the CSRF check (no Origin header from Node fetch). */
export function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers });
}

/**
 * Persist a log line to the job's log file AND broadcast it over the
 * Socket.IO server so any open client renders it immediately. The two
 * layers are deliberate: socket pushes are best-effort (a client that
 * just connected won't see lines emitted before its subscription), the
 * log file is the source of truth on reattach.
 */
export async function log(jobId: string, line: string): Promise<void> {
  await appendLog(jobId, line);
  emitJobLog(jobId, line);
}

export async function patchJob(
  jobId: string,
  partial: Parameters<typeof updateJob>[1],
): Promise<JobState | null> {
  const next = await updateJob(jobId, partial);
  if (next) emitJobUpdate(next);
  return next;
}

/** Mark the install run non-green with a standing warning (#2160/#2161).
 *  Appends to `JobState.warnings` (deep-merge can't append arrays, so we
 *  read → concat → write the whole array). The install still reaches
 *  `phase: 'done'`, but a non-empty `warnings` flags it as "completed with
 *  warnings" in the Done UI. Best-effort; never throws. */
export async function appendJobWarning(jobId: string, warning: string): Promise<void> {
  const job = await getJob(jobId).catch(() => null);
  const warnings = [...(job?.warnings ?? []), warning];
  await patchJob(jobId, { warnings }).catch(() => undefined);
}
