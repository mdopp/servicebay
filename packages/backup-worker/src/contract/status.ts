// backup-worker ↔ servicebay status-file contract (#1955, slice of #1949).
//
// THE CONTRACT. The worker runs the heavy walk/copy/tar of every installed
// service's config in its OWN resource-capped container and writes its progress
// to a SHARED volume. servicebay launches + monitors the worker and reads ONLY
// the compact status.json — it never pulls the file lists / tar bytes (which
// OOM'd the control plane in-process at ~5.3 GB, see #1894 /
// feedback_control_plane_vs_worker) into its own process.
//
// The heavy artifacts are the per-service `<service>.tar` files the worker writes
// alongside status.json into the out-volume. servicebay streams each tar to the
// NAS one at a time (light, bounded I/O) — it never holds them all in memory.
//
// The shape lives HERE, in one module, so the worker (writer) and servicebay
// (reader) cannot drift (operator decision 2026-06-18: shared contracts stay in
// one place).

/** Canonical file name the worker writes into the shared out-volume. */
export const STATUS_FILE = 'status.json';

/** Schema version of the status contract. Bump on any breaking shape change. */
export const STATUS_CONTRACT_VERSION = 1 as const;

/**
 * The phase the worker is in. Linear, two terminal states (`done`/`error`).
 *   staging  — walking each service's config dir (read-only) + copying/tarring.
 *   done     — every requested service processed (each result has ok/skip/error).
 *   error    — the run aborted before completing (see `error`); per-service
 *              failures do NOT abort the run, they land in `results`.
 */
export type WorkerPhase = 'staging' | 'done' | 'error';

/** One service's outcome — compact: a tar name + size, never the file list. */
export interface ServiceBackupResult {
  service: string;
  /** Did the service produce a tar? false for a skip (no config on disk) or error. */
  ok: boolean;
  /** Relative tar name in the out-volume (`<service>.tar`) when ok, else null. */
  tarName: string | null;
  /** Tar size in bytes when ok, else 0. */
  bytes: number;
  /** Number of config files staged into the tar (rollup count, not the list). */
  files: number;
  /** "skip" when the service had no config to back up; "error" on a failure. */
  outcome: 'ok' | 'skip' | 'error';
  /** Failure message when outcome is "error"; the skip reason for "skip"; else null. */
  detail: string | null;
}

/**
 * The compact status document. Small enough to rewrite on every per-service tick
 * without I/O pressure. Holds NO file lists and NO tar bytes — only scalars and
 * the per-service rollup. The heavy tars live beside it in the out-volume.
 */
export interface WorkerStatus {
  /** Contract schema version (=== STATUS_CONTRACT_VERSION when written by this worker). */
  version: typeof STATUS_CONTRACT_VERSION;
  /** Opaque id servicebay assigns the run (mirrors the launch handle). */
  runId: string;
  phase: WorkerPhase;
  /** Human-readable one-liner for the current step (e.g. "Backing up home-assistant …"). */
  step: string;
  /** Total services the run will process. */
  total: number;
  /** Services processed so far (ok + skip + error), grows during `staging`. */
  processed: number;
  /** Per-service rollup — compact (tar name/size/file count), no file lists. */
  results: ServiceBackupResult[];
  /** Set only in `error` phase: the run-level failure message. null otherwise. */
  error: string | null;
  /** Epoch ms of the last write — servicebay's liveness/staleness signal. */
  updatedAt: number;
  /** Epoch ms the worker started. */
  startedAt: number;
}

/** A fresh status doc at run start (phase `staging`, nothing processed yet). */
export function initialStatus(runId: string, total: number, now: number = Date.now()): WorkerStatus {
  return {
    version: STATUS_CONTRACT_VERSION,
    runId,
    phase: 'staging',
    step: 'Starting …',
    total,
    processed: 0,
    results: [],
    error: null,
    updatedAt: now,
    startedAt: now,
  };
}
