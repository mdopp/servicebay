/**
 * `content_backup` + `config_backup` probes (#2615) — the two backup
 * mechanisms, reported as two separate, named states.
 *
 * The incident this exists for: on the reference box **Backup Sync was never
 * configured at all** (`config.backup` absent), its only recorded run failed on
 * 2026-07-19, and for over a year nothing anywhere said so. Meanwhile the
 * nightly NAS run was healthy (`11/11 services backed up`) — but that fact was
 * only ever in the journal, and it covers something else entirely. Doing
 * nothing looked exactly like working.
 *
 * So the two mechanisms get two rows that can never be collapsed into one:
 *
 *   - **Content backup** (`config.backup`, `lib/backup/service.ts`) — rsync of
 *     the operator-chosen source directories. The ONLY mechanism that can cover
 *     the bulk content under `/mnt/data`.
 *   - **Config backup** (`config.externalBackup`, `lib/externalBackup/`) — the
 *     nightly per-service config push to the NAS. Bulk volumes are excluded
 *     *structurally* (`EXCLUDED_BULK_VOLUMES` in `@servicebay/backup-manifest`),
 *     so a green run here says nothing about household data. Every detail this
 *     probe emits carries {@link CONFIG_ONLY_CAVEAT} for exactly that reason.
 *
 * Status choice is deliberate, and follows the issue's rule *"deliberately off
 * is fine, silently empty is not"*:
 *
 *   - never configured → **warn**. `diagnoseStatusToCheckStatus` maps warn to a
 *     failing check row, which is the point — an `info` here would be green, and
 *     green silence is the bug being fixed. It is still a *named state*
 *     (`state: 'not_configured'`) with plain-language text, never a raw
 *     exception the way the pre-#2443 crash surfaced it.
 *   - configured and explicitly switched off → **info**. That is a decision on
 *     the record, and a decision is allowed to be quiet.
 */

import { getConfig } from '@/lib/config';
import { getBackupHistory } from '@/lib/backup/service';
import { isOutOfSpaceError, isConnectionLevelError } from '@/lib/externalBackup/producer';
import { resolveBackupSources, type BackupConfig, type BackupSchedule } from '@/lib/backup/types';

/**
 * Probe id + row label for each mechanism. Exported so `runDiagnose` and the
 * end-to-end health-check test name the same rows: the probe reaches the
 * operator as `diagnose:<id>` in `get_health_checks` and on the Checks page, so
 * the id is the contract, not an internal detail (#2591).
 */
export const CONTENT_BACKUP_PROBE_ID = 'content_backup';
export const CONTENT_BACKUP_PROBE_LABEL = 'Content backup (Backup Sync)';
export const CONFIG_BACKUP_PROBE_ID = 'config_backup';
export const CONFIG_BACKUP_PROBE_LABEL = 'Config backup (last nightly run)';

/** How long each schedule is *supposed* to leave between runs. */
const SCHEDULE_INTERVAL_MS: Record<BackupSchedule, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  monthly: 31 * 24 * 60 * 60_000,
};

/**
 * A run counts as overdue only once it is *well* past its own interval — one
 * missed slot is a restart or a slow night, two is a mechanism that stopped.
 */
export const OVERDUE_FACTOR = 2;

/** The nightly config push runs daily; that is its own interval. */
const CONFIG_BACKUP_INTERVAL_MS = SCHEDULE_INTERVAL_MS.daily;

/**
 * Appended to every `config_backup` detail so a green nightly run can never be
 * read as "everything is backed up". The exclusion is structural, not a
 * setting — see `EXCLUDED_BULK_VOLUMES`.
 */
export const CONFIG_ONLY_CAVEAT =
  'Covers per-service configuration only — the bulk content under /mnt/data (media library, photos, shared files) is excluded by design and is NOT in these tarballs. Content is covered by Backup Sync, reported separately as "Content backup".';

/** Human "3 days" / "5 hours" / "12 minutes", for ages up to a few months. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// ─── Content backup (Backup Sync) ────────────────────────────────────

/**
 * Named states of the content backup. Exported so the state is asserted by
 * name rather than by matching prose — "not configured" must stay
 * distinguishable from "never checked" and from a run that errored.
 */
type ContentBackupState =
  | 'not_configured'
  | 'switched_off'
  | 'no_sources'
  | 'never_ran'
  | 'last_run_failed'
  | 'overdue'
  | 'ok';

export interface ContentBackupProbeResult {
  status: 'ok' | 'warn' | 'info';
  state: ContentBackupState;
  detail: string;
  hint?: string;
}

const CONFIGURE_HINT =
  'Settings → Backup: pick the directories to protect and a target (local disk, SSH, SMB or NFS), then run it once. If you genuinely do not want a content backup, configure it and switch it off — that records a decision, which this check reports quietly.';

/** One-line "what would this cover", so the row never implies more than it does. */
function describeCoverage(config: BackupConfig): string {
  const sources = resolveBackupSources(config);
  if (sources.length === 0) return 'no source directories are chosen';
  return `${sources.length} source${sources.length === 1 ? '' : 's'} (${sources.map(s => s.path).join(', ')})`;
}

/** The never-configured state, plus whatever the history still remembers. */
async function notConfiguredResult(): Promise<ContentBackupProbeResult> {
  const history = await getBackupHistory();
  const last = history[0];
  const past = last
    ? ` The last run ever recorded (${last.completedAt.slice(0, 10)}) ${last.success ? 'succeeded' : `failed: ${last.message}`}, and nothing has run since.`
    : ' No run has ever been recorded.';
  return {
    status: 'warn',
    state: 'not_configured',
    detail:
      'Content backup (Backup Sync) has never been configured — there is no source directory and no target, so nothing under /mnt/data is being copied anywhere.' +
      past,
    hint: CONFIGURE_HINT,
  };
}

/** Classify a configured + enabled Backup Sync from its last recorded run. */
function classifyLastRun(config: BackupConfig, now: Date): ContentBackupProbeResult {
  const coverage = describeCoverage(config);
  const lastRun = config.lastRun ? Date.parse(config.lastRun) : NaN;
  if (!Number.isFinite(lastRun)) {
    return {
      status: 'warn',
      state: 'never_ran',
      detail: `Content backup is configured (${coverage}) but has never run, so nothing is protected yet.`,
      hint: 'Settings → Backup → Run now, to confirm the target actually accepts the data before relying on the schedule.',
    };
  }
  const age = formatAge(now.getTime() - lastRun);
  if (config.lastStatus === 'error') {
    return {
      status: 'warn',
      state: 'last_run_failed',
      detail: `The last content backup (${age} ago) FAILED: ${config.lastMessage ?? 'no message recorded'}. ${coverage} — none of it is known to be protected since then.`,
      hint: 'Settings → Backup → Test connection, then Run now. The failure message above names what the target rejected.',
    };
  }
  const overdueAfter = SCHEDULE_INTERVAL_MS[config.schedule] * OVERDUE_FACTOR;
  if (now.getTime() - lastRun > overdueAfter) {
    return {
      status: 'warn',
      state: 'overdue',
      detail: `Content backup is set to run ${config.schedule} but last ran ${age} ago — more than ${OVERDUE_FACTOR}× its own interval. ${coverage}.`,
      hint: 'The scheduler runs in the ServiceBay process; a restart loop or a long-unreachable target stops it silently. Run it once from Settings → Backup to see the current error.',
    };
  }
  return {
    status: 'ok',
    state: 'ok',
    detail: `Content backup ran ${age} ago and succeeded (${config.schedule} schedule, ${coverage}).`,
  };
}

export async function checkContentBackup(now: Date = new Date()): Promise<ContentBackupProbeResult> {
  const config = (await getConfig()).backup;
  if (!config) return notConfiguredResult();
  if (!config.enabled) {
    return {
      status: 'info',
      state: 'switched_off',
      detail: `Content backup is configured (${describeCoverage(config)}) but switched off, so nothing under /mnt/data is being copied. This is a recorded decision, not a fault.`,
      hint: 'Settings → Backup → enable, if that is no longer what you want.',
    };
  }
  if (resolveBackupSources(config).length === 0) {
    return {
      status: 'warn',
      state: 'no_sources',
      detail:
        'Content backup is enabled and has a target, but no source directory is chosen — every run copies nothing. A successful run here does not protect any data.',
      hint: 'Settings → Backup → add at least one source directory (e.g. /mnt/data).',
    };
  }
  return classifyLastRun(config, now);
}

// ─── Config backup (nightly NAS push) ────────────────────────────────

type ConfigBackupState =
  | 'switched_off'
  | 'never_ran'
  | 'nothing_installed'
  | 'last_run_failed'
  | 'partial'
  | 'connection_dropped'
  | 'incomplete'
  | 'overdue'
  | 'ok';

export interface ConfigBackupProbeResult {
  status: 'ok' | 'warn' | 'info';
  state: ConfigBackupState;
  detail: string;
  hint?: string;
}

/** Every detail carries the caveat — criterion (4) must hold in every state. */
function withCaveat(result: Omit<ConfigBackupProbeResult, 'detail'> & { detail: string }): ConfigBackupProbeResult {
  return { ...result, detail: `${result.detail} ${CONFIG_ONLY_CAVEAT}` };
}

type ExternalBackupRecord = NonNullable<Awaited<ReturnType<typeof getConfig>>['externalBackup']>;

/**
 * What to tell the operator when the run's own failure message says the NAS is
 * full (#2873). "Re-run it and check the per-service errors" is the wrong advice
 * there — the run already prunes and retries by itself, so the only remaining
 * operator action is capacity.
 */
const FULL_TARGET_HINT =
  'The destination reported itself full. Each run now sweeps partial uploads and prunes the oldest ' +
  'snapshots across all services before writing, then retries once, so the next run usually recovers on ' +
  'its own. If the message says the target is too small for one snapshot of each service, that is the one ' +
  'case left for you: a larger drive, or a lower retention count under Settings → Backups.';

const PARTIAL_HINT =
  'The named services have no config on the NAS from that run. Re-run it from Settings → Backups and check the per-service errors.';

/**
 * The failures were the DESTINATION dropping the connection, not the services
 * (#2876). Listing five identical `ECONNREFUSED` rows as five broken services
 * sent the operator to the wrong fix, so this state is named and hinted
 * separately from a genuine per-service `partial`.
 */
const CONNECTION_DROPPED_HINT =
  'This is one fact about the destination, not several broken services: the NAS closed the control connection part-way through the run, so every service after that point had nowhere to write. The run now shares one FTP session and backs off before retrying, so a re-run usually gets through. If it keeps happening, the share itself is the thing to look at — a FritzBox USB share that needs re-plugging, or an FTP server with a low concurrent-session limit.';

/**
 * A service's tar LANDED but is missing declared files (#2877). The run's own
 * tally reads "13/13", so without its own state this is invisible — and the file
 * it is usually missing is NPM's proxy-host/cert database, the one whose loss
 * means re-creating every route by hand. Name the structural cause, because the
 * operator cannot guess it: the live DB is owned by the container's uid-mapped
 * root at mode 0600, and the backup worker runs as a different uid, so the only
 * way to capture it is the collector's snapshot — and that is what failed.
 */
const INCOMPLETE_HINT =
  'The tar is on the NAS but does not hold every file the service declared. This is a permissions fact, not a ' +
  'flaky run: the file (typically NPM\'s data/database.sqlite) is owned by the container\'s uid-mapped root at ' +
  'mode 0600, so the backup worker cannot read it directly — it can only be captured by the collector snapshot ' +
  'ServiceBay takes before the worker starts. Search the ServiceBay log for "NPM sqlite snapshot" / "podman cp" ' +
  'to see why that snapshot did not happen, and re-run the backup once it does.';

/** Classify a recorded nightly run: denominator first, always. */
function classifyConfigRun(record: ExternalBackupRecord, now: Date): ConfigBackupProbeResult {
  const lastRun = record.lastRun ? Date.parse(record.lastRun) : NaN;
  if (!Number.isFinite(lastRun)) {
    return withCaveat({
      status: 'warn',
      state: 'never_ran',
      detail:
        'The nightly config backup to the NAS has no recorded run yet. Either it has not reached its slot since this version started, or it never ran.',
      hint: 'Settings → Backups → "Back up now" runs the same path on demand and records its result here.',
    });
  }
  return classifyRecordedConfigRun(record, lastRun, now);
}

/**
 * Which of the three causes the recorded message names, if any. Kept separate
 * from the classification below so a full destination (#2873) and a dropped
 * connection (#2876) each reach the operator with their own next step, rather
 * than the generic "check the per-service errors".
 */
function diagnoseRunCause(record: ExternalBackupRecord): {
  targetFull: boolean;
  connectionDropped: boolean;
} {
  const targetFull = isOutOfSpaceError(record.lastMessage);
  return { targetFull, connectionDropped: !targetFull && isConnectionLevelError(record.lastMessage) };
}

/** The hint for a run that did not cover everything, given its cause. */
function partialRunHint(cause: ReturnType<typeof diagnoseRunCause>, fallback: string): string {
  if (cause.targetFull) return FULL_TARGET_HINT;
  if (cause.connectionDropped) return CONNECTION_DROPPED_HINT;
  return fallback;
}

/** A run whose tars LANDED but are missing declared files (#2877), or null when
 *  every written backup is complete. */
function classifyIncompleteRun(
  record: ExternalBackupRecord,
  age: string,
  tally: string,
): ConfigBackupProbeResult | null {
  const incomplete = record.servicesIncomplete ?? [];
  if (incomplete.length === 0) return null;
  return withCaveat({
    status: 'warn',
    state: 'incomplete',
    detail:
      `The last config backup (${age} ago) wrote ${tally}, but ${incomplete.join(', ')} shipped WITHOUT some of ` +
      `the files ${incomplete.length === 1 ? 'it declares' : 'they declare'}. ${record.lastMessage ?? ''}`.trim(),
    hint: INCOMPLETE_HINT,
  });
}

/** The run aborted before it finished — its cause decides the next step. */
function failedRunResult(
  record: ExternalBackupRecord,
  age: string,
  tally: string,
  cause: ReturnType<typeof diagnoseRunCause>,
): ConfigBackupProbeResult {
  return withCaveat({
    status: 'warn',
    state: 'last_run_failed',
    detail: `The last config backup (${age} ago) FAILED before it finished: ${record.lastMessage ?? 'no message recorded'}. ${tally} were written.`,
    hint: partialRunHint(
      cause,
      'Check the "Config backup (FritzBox NAS)" row above — an unreachable or read-only target is the usual cause.',
    ),
  });
}

function classifyRecordedConfigRun(
  record: ExternalBackupRecord,
  lastRun: number,
  now: Date,
): ConfigBackupProbeResult {
  const age = formatAge(now.getTime() - lastRun);
  const ok = record.servicesOk ?? 0;
  const total = record.servicesTotal ?? 0;
  const tally = `${ok}/${total} services`;
  const cause = diagnoseRunCause(record);
  if (record.lastStatus === 'error') return failedRunResult(record, age, tally, cause);
  if (total === 0) {
    return withCaveat({
      status: 'info',
      state: 'nothing_installed',
      detail: `The last config backup ran ${age} ago and had nothing to do — 0/0 services: no installed service ships a backup manifest.`,
    });
  }
  if (ok < total) {
    return withCaveat({
      status: 'warn',
      state: cause.connectionDropped ? 'connection_dropped' : 'partial',
      detail: `The last config backup (${age} ago) covered only ${tally}. ${record.lastMessage ?? ''}`.trim(),
      hint: partialRunHint(cause, PARTIAL_HINT),
    });
  }
  const incompleteRun = classifyIncompleteRun(record, age, tally);
  if (incompleteRun) return incompleteRun;
  if (now.getTime() - lastRun > CONFIG_BACKUP_INTERVAL_MS * OVERDUE_FACTOR) {
    return withCaveat({
      status: 'warn',
      state: 'overdue',
      detail: `The config backup is nightly but last ran ${age} ago — more than ${OVERDUE_FACTOR}× its own interval. Its last result was ${tally}.`,
      hint: 'The nightly timer lives in the ServiceBay process; a restart before the slot pushes it out. Run it once from Settings → Backups.',
    });
  }
  return withCaveat({
    status: 'ok',
    state: 'ok',
    detail: `The nightly config backup ran ${age} ago: ${tally} written to the NAS.`,
  });
}

export async function checkConfigBackup(now: Date = new Date()): Promise<ConfigBackupProbeResult> {
  const record = (await getConfig()).externalBackup;
  if (record?.enabled === false) {
    return withCaveat({
      status: 'info',
      state: 'switched_off',
      detail: 'The nightly config backup to the NAS is switched off. This is a recorded decision, not a fault.',
      hint: 'Settings → Backups → enable, if that is no longer what you want.',
    });
  }
  return classifyConfigRun(record ?? { enabled: true }, now);
}
