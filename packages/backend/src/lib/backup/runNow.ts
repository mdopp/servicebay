/**
 * "Back up now", as ONE path (#2872).
 *
 * The box has two backup mechanisms, and ADR 0002 keeps them deliberately
 * distinct: **Backup Sync** rsyncs the operator's bulk content directories to a
 * destination they chose (Tier B), and the **NAS config backup**
 * (`lib/externalBackup/`) pushes each installed service's configuration to the
 * NAS every night (Tier A). They are not interchangeable and this module does
 * not merge them — it only decides which one an on-demand "run a backup now"
 * can actually execute.
 *
 * The bug it exists for: on the reference box `config.backup.target` held
 * residue a connection probe left behind — `{ type: 'local', path:
 * '/mnt/backup', host: 'probe-verify.invalid', … }` with `enabled: false` — so
 * every `run_backup` chose the Backup-Sync branch and died in 0 s on an ENOENT
 * for a `/mnt/backup` that has never existed on that node. Nothing was backed
 * up and no other path was ever tried, while the nightly NAS run beside it was
 * healthy. So: with no *real* content target, run the NAS config backup and say
 * so; with one, Backup Sync behaves exactly as before.
 */
import { getConfig } from '../config';
import { logger } from '../logger';
import { hasUsableBackupSyncTarget, runBackup } from './service';
import {
    backupInstalledServicesToNas,
    summariseBackupRun as summariseNasRun,
    type ServiceBackupRunEntry,
} from '../externalBackup/producer';
import type { BackupRunResult } from './types';

export interface BackupNowResult extends BackupRunResult {
    /** Which mechanism the run actually exercised — never inferred from the message. */
    kind: 'content-sync' | 'nas-config';
    /** NAS runs only: the denominator first, then the per-service outcome. */
    servicesOk?: number;
    servicesTotal?: number;
    services?: ServiceBackupRunEntry[];
}

/**
 * Prefix on every NAS-fallback message. The operator asked for "a backup" and
 * got a different one than Backup Sync would have made — that substitution has
 * to be visible in the result itself, not only in the log.
 */
export const NAS_FALLBACK_PREFIX =
    'Backup Sync has no configured target, so this run backed up service configuration to the NAS instead:';

function elapsed(startedAt: Date): Pick<BackupRunResult, 'startedAt' | 'completedAt' | 'duration'> {
    const completedAt = new Date();
    return {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        duration: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
    };
}

/** The Tier-A config push, reported in `BackupRunResult` shape. */
async function runNasConfigBackup(): Promise<BackupNowResult> {
    const startedAt = new Date();
    try {
        const results = await backupInstalledServicesToNas();
        const ok = results.filter(r => r.ok).length;
        return {
            kind: 'nas-config',
            // Denominator first (#2877): a run where some service never got a
            // write is not a success, and 0/0 is a real "nothing to do".
            success: results.every(r => r.ok),
            message: `${NAS_FALLBACK_PREFIX} ${summariseNasRun(results)}`,
            servicesOk: ok,
            servicesTotal: results.length,
            services: results,
            ...elapsed(startedAt),
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error('Backup', `NAS config backup failed: ${message}`);
        return {
            kind: 'nas-config',
            success: false,
            message: `${NAS_FALLBACK_PREFIX} ${message}`,
            servicesOk: 0,
            servicesTotal: 0,
            services: [],
            ...elapsed(startedAt),
        };
    }
}

/**
 * Run whichever backup this box can actually run right now. Backup Sync when a
 * real content target is configured (its result is passed through untouched —
 * history entry, status and alerts all unchanged); the NAS config backup
 * otherwise.
 */
export async function runBackupNow(): Promise<BackupNowResult> {
    const config = (await getConfig()).backup;
    if (config && (await hasUsableBackupSyncTarget(config))) {
        return { ...(await runBackup(config)), kind: 'content-sync' };
    }
    logger.info(
        'Backup',
        'No usable Backup Sync target is configured — running the NAS config backup for this on-demand run (#2872)',
    );
    return runNasConfigBackup();
}
