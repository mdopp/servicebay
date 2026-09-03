'use client';

/**
 * The one client-side view of the install job (#2732).
 *
 * The install job is a server-side singleton (`/api/install/start` answers
 * 409 while one is active), but five surfaces used to poll it on their own —
 * the wizard's controller, `/setup`, the Home card, the offline banner and
 * the mobile nav badge — at three different cadences, with the
 * `/status → /progress` 401 fallback present in only some of the copies. So
 * `/setup` and the wizard could disagree about the same job at the same
 * moment, and every dashboard tab ran three to four polls instead of one.
 *
 * This provider owns the poll. Everything that shows the job reads it from
 * here (`useInstallJob`); `useStackInstall` keeps only configure/start and
 * derives its progress state from this context.
 *
 * Polling, not the socket: 3.25.x subscribed to install events and raced the
 * socket handshake (`useSocket` returned `undefined` on first render), so the
 * wizard never saw `done`. A poll works whether or not the socket connects,
 * and after a tab reopen it simply reads from wherever the log file is now.
 *
 * Cadence: {@link INSTALL_POLL_MS}, setTimeout-rescheduled so a slow fetch
 * never overlaps the next tick. One cadence for every state — an idle
 * dashboard tab now costs one request per tick instead of the three it made
 * before.
 *
 * Fallback: `/api/install/status` is cookie-gated and carries the full job.
 * A clean install that wipes `secrets` rotates AUTH_SECRET mid-run, the
 * operator's cookie stops being trusted, and every `/status` poll 401s while
 * the install keeps going (#663 — S1). When we already know the job id we
 * fall back to the jobId-gated, sanitised `/api/install/progress`, so the
 * overlay keeps moving. That endpoint strips `input`, `credentialsManifest`
 * and the credential fallback; same-job responses are merged over the last
 * full snapshot so those fields survive the fallback.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JobPhase, JobState } from '@servicebay/api-client';

export const INSTALL_POLL_MS = 2000;

/**
 * The job as the client sees it. `/status` reports the full `JobState`; the
 * `/progress` fallback omits the operator-facing secrets, so those fields are
 * optional and carried over from the last full response for the same job.
 */
export type InstallJobSnapshot =
  Omit<JobState, 'source' | 'input' | 'credentialsManifest' | 'needsCredentials'>
  & Partial<Pick<JobState, 'source' | 'input' | 'credentialsManifest' | 'needsCredentials'>>;

/** Client-facing display phase shared by every install surface. */
export type InstallDisplayPhase = 'idle' | 'installing' | 'done' | 'error';

export interface InstallCredentialsPrompt {
  /** The runner is paused on the NPM credentials prompt and the operator
   *  has not answered it since the last poll. An answer (submit or skip)
   *  hides the prompt until the next poll reports the job again — if the
   *  runner is still waiting then, it comes back. */
  prompt: boolean;
  /** Pre-fill for the prompt — the values ServiceBay had stored. Empty
   *  strings when `/progress` answered (it does not carry them). */
  fallback: { email: string; password: string };
  /** Why the last `submitCredentials` could not be sent, or null. Shown
   *  next to the prompt's inputs so a rejected submit is visible instead
   *  of a dead button (#2442). */
  error: string | null;
}

export interface InstallJobContextValue {
  /** The first poll has answered — successfully or not. Consumers that
   *  decide something once on mount (the wizard's auto-open) wait for it. */
  ready: boolean;
  /** The active job, else the most recent one, else null. */
  job: InstallJobSnapshot | null;
  /** `running` / `needs_credentials`. */
  jobIsActive: boolean;
  /** Config flag: the operator has not pressed Finish on `/setup` yet. */
  stackSetupPending: boolean;
  /** When the current server process booted; lets the wizard tell a job
   *  from this boot apart from one left on disk by a previous OS. */
  serverStartedAt: string | null;
  phase: InstallDisplayPhase;
  /** Every log line of `job` received so far, in order. */
  logs: string[];
  credentials: InstallCredentialsPrompt;
  /** POST /api/install/abort for the job being followed. */
  abort: () => void;
  /** POST /api/install/skip-credentials for the job being followed. */
  skipCredentials: () => void;
  /** POST /api/install/credentials for the job being followed. Hides the
   *  prompt while the runner processes the answer; a submit it cannot
   *  send (missing field, transport failure) sets `credentials.error` and
   *  leaves the prompt open rather than returning silently (#2442). */
  submitCredentials: (email: string, password: string) => Promise<void>;
  /** Follow a specific job — the one this tab just started, or the one the
   *  server says is running — and fetch it now instead of waiting for the
   *  next tick. Resolves `true` when the server knows the job. */
  track: (jobId: string) => Promise<boolean>;
}

const InstallJobContext = createContext<InstallJobContextValue | undefined>(undefined);

const ACTIVE_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(['running', 'needs_credentials']);
const FAILED_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(['error', 'aborted', 'crashed']);

export function isActivePhase(phase: JobPhase | undefined): boolean {
  return phase !== undefined && ACTIVE_PHASES.has(phase);
}

export function isFailedPhase(phase: JobPhase | undefined): boolean {
  return phase !== undefined && FAILED_PHASES.has(phase);
}

/** Map the server phase to the display phase the wizard understands.
 *  `crashed` and `aborted` both surface as `error` so one Start-over UI
 *  covers every terminal failure. */
export function toDisplayPhase(phase: JobPhase | undefined): InstallDisplayPhase {
  if (phase === undefined) return 'idle';
  if (isActivePhase(phase)) return 'installing';
  if (phase === 'done') return 'done';
  return 'error';
}

const EMPTY_FALLBACK = { email: '', password: '' } as const;
const NO_PROMPT: InstallCredentialsPrompt = { prompt: false, fallback: EMPTY_FALLBACK, error: null };

interface CredentialsAnswer {
  /** The job snapshot that was current when the operator answered. Every
   *  poll yields a fresh snapshot, so "answered" lasts exactly until the
   *  server has been asked again. */
  answeredFor: InstallJobSnapshot | null;
  error: string | null;
}

const NO_ANSWER: CredentialsAnswer = { answeredFor: null, error: null };

interface Snapshot {
  ready: boolean;
  job: InstallJobSnapshot | null;
  jobIsActive: boolean;
  stackSetupPending: boolean;
  serverStartedAt: string | null;
  logs: string[];
}

const INITIAL: Snapshot = {
  ready: false,
  job: null,
  jobIsActive: false,
  stackSetupPending: false,
  serverStartedAt: null,
  logs: [],
};

/** What either endpoint answers. `/progress` reports `needsCredentials` as a
 *  boolean and omits the operator-facing fields. */
interface PollResponse {
  job: (Omit<InstallJobSnapshot, 'needsCredentials'> & { needsCredentials?: JobState['needsCredentials'] | boolean }) | null;
  jobIsActive?: boolean;
  stackSetupPending?: boolean;
  serverStartedAt?: string;
  logs?: string;
  logsOffset?: number;
}

/** Fold a response's job over the previous snapshot of the same job so a
 *  sanitised `/progress` answer does not wipe what `/status` told us. */
function mergeJob(prev: InstallJobSnapshot | null, next: NonNullable<PollResponse['job']>): InstallJobSnapshot {
  const base = prev && prev.id === next.id ? prev : null;
  const { needsCredentials, ...rest } = next;
  const merged: InstallJobSnapshot = { ...(base ?? {}), ...rest };
  if (typeof needsCredentials === 'boolean') {
    merged.needsCredentials = needsCredentials
      ? (base?.needsCredentials ?? { fallback: { ...EMPTY_FALLBACK } })
      : undefined;
  } else {
    merged.needsCredentials = needsCredentials;
  }
  return merged;
}

function splitLines(logs: string | undefined): string[] {
  return logs ? logs.split('\n').filter(l => l.length > 0) : [];
}

/** Where the poll is: which job it follows, whether that job was active on
 *  the last response, and how far into its log file we have read. */
interface PollCursor {
  tracked: string | null;
  active: boolean;
  offset: number;
}

const START: PollCursor = { tracked: null, active: true, offset: 0 };

/** Fold one response into the next snapshot + cursor. Pure, so the merge
 *  rules (same-job log append, job-switch log reset, `/progress` field
 *  carry-over) are one function rather than a poll loop's local state. */
function fold(prev: Snapshot, cursor: PollCursor, data: PollResponse): { snap: Snapshot; cursor: PollCursor } {
  const common = {
    ready: true,
    stackSetupPending: data.stackSetupPending ?? prev.stackSetupPending,
    serverStartedAt: data.serverStartedAt ?? prev.serverStartedAt,
  };
  if (!data.job) {
    return { snap: { ...common, job: null, jobIsActive: false, logs: [] }, cursor: START };
  }
  const job = mergeJob(prev.job, data.job);
  const jobIsActive = typeof data.jobIsActive === 'boolean' ? data.jobIsActive : isActivePhase(job.phase);
  const sameJob = prev.job?.id === job.id && cursor.tracked === job.id;
  // A different job than the one the offset belonged to: its log was read
  // from the wrong offset, so start it over. When the offset was still 0
  // the lines are the job's own and can be kept.
  const logsValid = sameJob || cursor.offset === 0;
  const newLines = logsValid ? splitLines(data.logs) : [];
  let logs: string[];
  if (sameJob) logs = newLines.length > 0 ? [...prev.logs, ...newLines] : prev.logs;
  else logs = newLines;
  const offset = logsValid && typeof data.logsOffset === 'number' ? data.logsOffset : 0;
  return {
    snap: { ...common, job, jobIsActive, logs },
    cursor: { tracked: job.id, active: jobIsActive, offset },
  };
}

/** Pin the job id only while it is active: the server can then answer with
 *  one file read instead of a directory scan. Once it is terminal we ask
 *  for "whatever is current" again, so a re-deploy the operator kicks off
 *  elsewhere is discovered instead of the page staying glued to the
 *  finished job. */
function statusUrl(cursor: PollCursor): string {
  const pin = cursor.tracked !== null && cursor.active ? `&jobId=${encodeURIComponent(cursor.tracked)}` : '';
  return `/api/install/status?logsSince=${cursor.offset}${pin}`;
}

function progressUrl(cursor: PollCursor & { tracked: string }): string {
  return `/api/install/progress?jobId=${encodeURIComponent(cursor.tracked)}&logsSince=${cursor.offset}`;
}

/** One request with the 401 fallback (#663 — S1). `null` when nothing
 *  usable came back. */
async function fetchJob(cursor: PollCursor): Promise<PollResponse | null> {
  let res = await fetch(statusUrl(cursor), { cache: 'no-store' });
  if (res.status === 401 && cursor.tracked !== null) {
    res = await fetch(progressUrl({ ...cursor, tracked: cursor.tracked }), { cache: 'no-store' });
  }
  if (!res.ok) return null;
  return (await res.json()) as PollResponse;
}

export function InstallJobProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot>(INITIAL);
  const [credAnswer, setCredAnswer] = useState<CredentialsAnswer>(NO_ANSWER);
  const cursorRef = useRef<PollCursor>(START);
  /** Mirror of `snap` for the async poll to read and merge over; written
   *  only from the poll, never during render. */
  const snapRef = useRef<Snapshot>(INITIAL);
  const inFlightRef = useRef<Promise<string | null> | null>(null);
  const commit = useCallback((next: Snapshot) => {
    snapRef.current = next;
    setSnap(next);
  }, []);

  /** One poll. Resolves to the id of the job the server answered with. */
  const tick = useCallback(async (): Promise<string | null> => {
    if (inFlightRef.current) return inFlightRef.current;
    const run = (async (): Promise<string | null> => {
      try {
        const data = await fetchJob(cursorRef.current);
        if (!data) return null;
        const next = fold(snapRef.current, cursorRef.current, data);
        cursorRef.current = next.cursor;
        commit(next.snap);
        return next.snap.job?.id ?? null;
      } catch {
        // offline / mid-redeploy — keep the previous value, try next tick
        return null;
      } finally {
        if (!snapRef.current.ready) commit({ ...snapRef.current, ready: true });
      }
    })();
    inFlightRef.current = run;
    try {
      return await run;
    } finally {
      inFlightRef.current = null;
    }
  }, [commit]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await tick();
      if (!cancelled) timer = setTimeout(loop, INSTALL_POLL_MS);
    };
    void loop();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [tick]);

  const track = useCallback(async (jobId: string): Promise<boolean> => {
    if (cursorRef.current.tracked !== jobId) {
      cursorRef.current = { tracked: jobId, active: true, offset: 0 };
    }
    // A tick already on the wire may be answering for the old job; wait it
    // out and ask again so the caller gets the job it asked for.
    if (inFlightRef.current) await inFlightRef.current.catch(() => undefined);
    return (await tick()) === jobId;
  }, [tick]);

  const post = useCallback((path: string, body: Record<string, unknown>) =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), []);

  const abort = useCallback(() => {
    const id = cursorRef.current.tracked;
    if (!id) return;
    void post('/api/install/abort', { jobId: id }).catch(() => undefined);
  }, [post]);

  const skipCredentials = useCallback(() => {
    const id = cursorRef.current.tracked;
    if (!id) return;
    setCredAnswer({ answeredFor: snapRef.current.job, error: null });
    void post('/api/install/skip-credentials', { jobId: id }).catch(() => undefined);
  }, [post]);

  const submitCredentials = useCallback(async (email: string, password: string) => {
    // Every bail-out below used to `return` silently, which rendered the
    // "Authenticate & Retry" button dead — the operator clicked and
    // nothing at all happened (#2442). Each one now says why.
    if (!email) {
      setCredAnswer({ answeredFor: null, error: 'Enter the NPM admin email — ServiceBay had no stored value to pre-fill.' });
      return;
    }
    if (!password) {
      setCredAnswer({ answeredFor: null, error: 'Enter the NPM admin password.' });
      return;
    }
    const id = cursorRef.current.tracked;
    if (!id) {
      setCredAnswer({ answeredFor: null, error: 'This install is no longer attached to a job — start over to retry.' });
      return;
    }
    setCredAnswer({ answeredFor: snapRef.current.job, error: null });
    try {
      await post('/api/install/credentials', { jobId: id, email, password });
    } catch {
      // Re-show the prompt so the operator can retry. The runner stays
      // paused on the in-memory promise; nothing has been committed.
      setCredAnswer({ answeredFor: null, error: 'Could not reach ServiceBay to submit the credentials. Check the connection and retry.' });
    }
  }, [post]);

  const value = useMemo<InstallJobContextValue>(() => {
    const job = snap.job;
    const waiting = job !== null && job.phase === 'needs_credentials' && !!job.needsCredentials;
    const answered = waiting && credAnswer.answeredFor === job;
    const credentials: InstallCredentialsPrompt = waiting && !answered
      ? { prompt: true, fallback: job.needsCredentials!.fallback, error: credAnswer.error }
      : NO_PROMPT;
    return {
      ready: snap.ready,
      job,
      jobIsActive: snap.jobIsActive,
      stackSetupPending: snap.stackSetupPending,
      serverStartedAt: snap.serverStartedAt,
      phase: toDisplayPhase(job?.phase),
      logs: snap.logs,
      credentials,
      abort,
      skipCredentials,
      submitCredentials,
      track,
    };
  }, [snap, credAnswer, abort, skipCredentials, submitCredentials, track]);

  return <InstallJobContext.Provider value={value}>{children}</InstallJobContext.Provider>;
}

export function useInstallJobContext(): InstallJobContextValue {
  const ctx = useContext(InstallJobContext);
  if (!ctx) throw new Error('useInstallJob must be used within an InstallJobProvider');
  return ctx;
}
