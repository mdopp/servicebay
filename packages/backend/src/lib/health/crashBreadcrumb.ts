/**
 * Out-of-band crash breadcrumb reader (#2159).
 *
 * ServiceBay's own crash-loop is otherwise invisible: when `servicebay.service`
 * exit-loops (the real incident: a root-owned `*.bak-verify*` stray broke the
 * `:Z` relabel → podman exit 126, UI dark on :5888 while every stack stayed
 * up), the thing that would report the failure IS the failing container, so the
 * operator gets nothing — no UI, no probe, no signal.
 *
 * The signal therefore has to be written OUT-OF-BAND, on the host, by systemd —
 * NOT by this container (which cannot even edit its own host quadlet; see
 * lib/hostDataDir.ts). The host-side writer is the `ExecStopPost=` hook on the
 * `servicebay.container` quadlet (tools/sb/internal/build/assets/fedora-coreos.bu):
 * on an abnormal stop it drops `last-crash.json` (exit code + service result +
 * last journal lines + timestamp + a named likely-cause) into the data dir —
 * a host path that survives the container being down.
 *
 * This module is the IN-BAND half of the read path: once the container recovers
 * (a restart eventually succeeds, or the operator heals the stray), the backend
 * reads the same file from {@link DATA_DIR} (`/app/data`, which is the very
 * `${DATA_ROOT}/servicebay` the host wrote to) and surfaces the last crash with
 * a recovery hint. The pure {@link parseCrashBreadcrumb} is also the format
 * contract the writer must honour and an out-of-band reader (sb-tui over SSH,
 * follow-up) can reuse.
 *
 * Reading it is best-effort: a missing file (never crashed, or the box predates
 * the writer) or a corrupt one degrades to `null`, never throws.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../dirs';
import { logger } from '../logger';

/** The host-written breadcrumb filename, in the data volume. */
export const CRASH_BREADCRUMB_FILE = path.join(DATA_DIR, 'last-crash.json');

/** The raw JSON shape the ExecStopPost writer produces. All string-typed
 *  because the writer emits shell values verbatim (systemd's $EXIT_STATUS is a
 *  numeric code OR a signal name; $EXIT_CODE is "exited"/"killed"/…). */
export interface CrashBreadcrumbRaw {
  unit?: string;
  timestamp?: string;
  service_result?: string;
  exit_code?: string;
  exit_status?: string;
  likely_cause?: string;
  journal_tail?: string;
}

/** The parsed, presentable breadcrumb. */
export interface CrashBreadcrumb {
  /** The failing unit (always `servicebay.service` from the current writer). */
  unit: string;
  /** ISO timestamp of the stop, or `'unknown'`. */
  timestamp: string;
  /** systemd $SERVICE_RESULT: `exit-code` | `signal` | `oom-kill` | … */
  serviceResult: string;
  /** systemd $EXIT_CODE: `exited` | `killed` | `unknown`. */
  exitCode: string;
  /** systemd $EXIT_STATUS: the numeric code (e.g. `126`) or a signal name. */
  exitStatus: string;
  /** Last journal lines for the unit at the time of the stop (may be empty). */
  journalTail: string;
  /** A human recovery hint, derived from the exit status + writer-named cause. */
  recoveryHint: string;
}

/**
 * The known relabel/permission failure class. `podman run` exits 126 when it
 * cannot relabel the `:Z` data volume — most often because a foreign-owned
 * stray (a root-owned `*.bak-verify*` left by an aborted verify) sits in the
 * data dir. The `ExecStartPre` self-heal (fedora-coreos.bu) removes those
 * strays and reclaims foreign-owned files, so the common case is fixed, not
 * just reported; this hint covers a recurrence.
 */
export const RELABEL_HINT =
  'Exit 126 usually means podman could not relabel the :Z data volume — a foreign-owned stray ' +
  '(often a root-owned *.bak-verify* leftover from an aborted verify) in the data dir breaks the ' +
  'relabel. The ExecStartPre self-heal removes those strays and reclaims foreign-owned files; if ' +
  'this recurs, check ownership under the ServiceBay data dir (should be the box user, not root).';

/** Derive a recovery hint from the exit status, preferring the writer's own
 *  named cause when present. Exit 126 → the relabel/permission class. */
export function recoveryHintFor(exitStatus: string, likelyCause?: string): string {
  if (exitStatus.trim() === '126') return RELABEL_HINT;
  const named = (likelyCause ?? '').trim();
  if (named && named !== 'see journal_tail') return named;
  return 'Check the journal tail below for the crash cause (missing env, EPERM, OOM, port collision).';
}

/**
 * Parse raw breadcrumb JSON into a presentable {@link CrashBreadcrumb}, or
 * `null` if it isn't a usable object. Pure — the format contract for the
 * host-side writer and any out-of-band reader. Tolerates missing fields
 * (fills `'unknown'`) so a partial write still surfaces something.
 */
export function parseCrashBreadcrumb(json: string): CrashBreadcrumb | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as CrashBreadcrumbRaw;
  const str = (v: unknown, fallback = 'unknown'): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback;

  const exitStatus = str(r.exit_status);
  return {
    unit: str(r.unit, 'servicebay.service'),
    timestamp: str(r.timestamp),
    serviceResult: str(r.service_result),
    exitCode: str(r.exit_code),
    exitStatus,
    journalTail: typeof r.journal_tail === 'string' ? r.journal_tail : '',
    recoveryHint: recoveryHintFor(exitStatus, r.likely_cause),
  };
}

/**
 * Read + parse the last-crash breadcrumb from the data dir. Returns `null` when
 * there is no breadcrumb (never crashed / pre-writer box) or on any read/parse
 * error — never throws. This is the in-band surface, valid once the container
 * has recovered; while it's still down, read the same file out-of-band.
 */
export function readCrashBreadcrumb(): CrashBreadcrumb | null {
  try {
    if (!fs.existsSync(CRASH_BREADCRUMB_FILE)) return null;
    return parseCrashBreadcrumb(fs.readFileSync(CRASH_BREADCRUMB_FILE, 'utf-8'));
  } catch (e) {
    logger.warn(
      'CrashBreadcrumb',
      `Could not read crash breadcrumb: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
