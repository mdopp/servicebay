'use client';

// Disk-import async-job polling hook (#1897).
//
// Owns the client side of the background scan/apply jobs: it polls
// `/api/system/disk-import/status?id=` until a job reaches a terminal phase,
// surfaces live progress, and re-attaches to a job left in localStorage after a
// reload / navigate-away (the durable store #1896 makes the job survive a
// backend restart too). Extracted from DiskImportSection so the card component
// stays a thin render layer.
//
// Lives in the feature `_lib/` with a relative import — a frontend util can't
// use `@/lib` (that alias resolves to the backend; memory
// `reference_at_lib_alias_is_backend`).

import { useCallback, useEffect, useRef, useState } from 'react';

/** Live progress from the status poll. Mirrors the backend SessionProgress. */
export interface JobProgress {
  step: 'mount' | 'walk' | 'hash' | 'plan' | 'copy' | 'done';
  scanned: number;
  hashed: number;
  copied: number;
  bytes: number;
  total: number;
}

export interface ScanReviewLike {
  sessionId: string;
  device: string;
  totalFiles: number;
  totalBytes: number;
  categories: unknown[];
  actions: unknown[];
  /** The per-folder routing tree (#1915). Absent on pre-#1915 payloads. */
  tree?: unknown[];
  /** Box users driving the Owner picker (#1915). */
  boxUsers?: string[];
  /** The disk-default owner seeding the root (#1915). */
  defaultOwner?: string;
}

/** Background-dedup sub-state (#1937). The scan renders the tree at `reviewed`
 *  immediately and hashes/dedups in the BACKGROUND; this drives a non-blocking
 *  "checking duplicates… N / M" line WITHOUT gating the tree. Absent on a
 *  pre-#1937 backend → treat as `done`. */
export type DedupState = 'pending' | 'running' | 'done' | 'partial';

/** The status-route payload the card polls. */
export interface JobStatus {
  sessionId: string;
  device: string;
  phase: 'scanning' | 'reviewed' | 'applying' | 'applied' | 'error';
  progress: JobProgress;
  error?: string;
  review?: ScanReviewLike;
  applied?: number;
  /** Background-dedup sub-state (#1937) + its hashed/total counters. */
  dedup?: DedupState;
  dedupHashed?: number;
  dedupTotal?: number;
}

/** Which background pass we're tracking — routes a terminal status. */
export type JobKind = 'scanning' | 'applying';

/** localStorage key for the in-flight job id so a reopened/reloaded card
 *  re-attaches to a running or finished disk-import job. */
export const ACTIVE_JOB_KEY = 'sb.diskImport.activeJob';

function readActiveJob(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_JOB_KEY) : null;
  } catch {
    return null;
  }
}
function writeActiveJob(id: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (id) window.localStorage.setItem(ACTIVE_JOB_KEY, id);
    else window.localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* private mode / disabled storage — non-fatal, just lose re-attach */
  }
}

const POLL_INTERVAL_MS = 1500;

/** One status fetch. 404 → the job is gone (pruned/forged); a usable body →
 *  route it; anything else → swallow (the next tick retries). */
async function pollOnce(
  jobId: string,
  cancelled: { current: boolean },
  onStatus: (s: JobStatus) => void,
  onGone: () => void,
): Promise<void> {
  try {
    const res = await fetch(`/api/system/disk-import/status?id=${encodeURIComponent(jobId)}`);
    if (res.status === 404) {
      if (!cancelled.current) onGone();
      return;
    }
    const data = (await res.json().catch(() => null)) as JobStatus | null;
    if (!cancelled.current && data && res.ok) onStatus(data);
  } catch {
    /* transient network blip — the next tick retries */
  }
}

/** Terminal-transition callbacks the card wires its UI state to. */
export interface ImportJobHandlers {
  onReviewed: (review: ScanReviewLike | null) => void;
  onApplied: (applied: number) => void;
  onError: (kind: JobKind | null, message: string | undefined, review: ScanReviewLike | null) => void;
  /** A polled job came back 404 (pruned / unknown id) — drop it. */
  onGone: () => void;
}

export interface UseImportJob {
  /** Live status of the polled job, or null when idle. */
  status: JobStatus | null;
  /** True while a background job is being polled. */
  active: boolean;
  /** Begin polling a freshly-handed-off job id (from scan/apply). */
  track: (jobId: string, kind: JobKind) => void;
  /** Stop polling + clear the persisted id (e.g. on reset). */
  clear: () => void;
}

/** Route a polled status to the card's handlers. Returns true if the job is in
 *  a TERMINAL phase (the caller stops polling); false to keep polling. */
function routeStatus(s: JobStatus, kind: JobKind | null, h: ImportJobHandlers): boolean {
  if (s.phase === 'reviewed') {
    // Review-first (#1937): hand the card the tree the MOMENT the scan reviews,
    // even though background dedup may still be running. Keep polling while
    // dedup is pending/running so the "checking duplicates…" line fills in live;
    // only treat the scan as terminal once dedup is done/partial. (Pre-#1937
    // backends have no `dedup` → treat as done = terminal immediately.)
    h.onReviewed(s.review ?? null);
    if (kind === 'applying') return false; // mid-apply a reviewed re-read isn't terminal
    const dedup = s.dedup ?? 'done';
    return dedup === 'done' || dedup === 'partial';
  }
  if (s.phase === 'applied') {
    h.onApplied(s.applied ?? 0);
    return true;
  }
  if (s.phase === 'error') {
    h.onError(kind, s.error, s.review ?? null);
    return true;
  }
  return false; // scanning / applying
}

/**
 * Poll a disk-import job to terminal, routing each terminal phase to the card's
 * handlers. `pendingKindRef` latches which pass we're tracking so the handler
 * can route without being a poll-effect dependency (which would tear the
 * interval down each tick). Re-attaches to a localStorage job on mount.
 */
export function useImportJob(handlers: ImportJobHandlers): UseImportJob {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const pendingKindRef = useRef<JobKind | null>(null);
  // Keep the latest handlers in a ref so the poll effect doesn't re-subscribe
  // when the card re-renders (handlers are inline closures). Updated in an
  // effect, not during render (refs are write-only-in-effects under the lint).
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const stop = useCallback(() => {
    pendingKindRef.current = null;
    setJobId(null);
    writeActiveJob(null);
  }, []);

  const track = useCallback((id: string, kind: JobKind) => {
    pendingKindRef.current = kind;
    writeActiveJob(id);
    setStatus(null);
    setJobId(id);
  }, []);

  const handleStatus = useCallback((s: JobStatus) => {
    setStatus(s);
    // On any TERMINAL phase, stop polling and route to the card's handler. A
    // `reviewed` only finalises a scan (mid-apply we keep polling for the
    // applied result). scanning/applying: stay polling.
    if (routeStatus(s, pendingKindRef.current, handlersRef.current)) stop();
  }, [stop]);

  // One interval per jobId; torn down when the job clears or on unmount.
  useEffect(() => {
    if (!jobId) return;
    const cancelled = { current: false };
    const tick = () =>
      pollOnce(jobId, cancelled, handleStatus, () => {
        stop();
        handlersRef.current.onGone();
      });
    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(timer);
    };
  }, [jobId, handleStatus, stop]);

  // Re-attach to a job left in localStorage (reload / navigate back). Deferred
  // to a microtask so the setState doesn't fire synchronously inside the effect
  // body (the "cascading renders" lint).
  useEffect(() => {
    const saved = readActiveJob();
    if (!saved) return;
    queueMicrotask(() => {
      pendingKindRef.current = null; // unknown until the first status; routes by phase
      setJobId(saved);
    });
  }, []);

  return { status, active: jobId !== null, track, clear: stop };
}
