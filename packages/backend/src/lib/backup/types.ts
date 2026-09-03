// src/lib/backup/types.ts

export type BackupTarget =
    | { type: 'local'; path: string }
    | { type: 'ssh'; host: string; port?: number; user: string; path: string; identityFile?: string }
    | { type: 'smb'; host: string; share: string; path?: string; username?: string; password?: string; domain?: string }
    | { type: 'nfs'; host: string; export: string; path?: string };

/**
 * The read-safe view of a target: identical to `BackupTarget` except the smb
 * share password is replaced by a `hasPassword` flag. The settings GET must
 * never echo the live secret (#2771) — the form shows "a password is stored"
 * and the operator overwrites it, the same write-only shape
 * `ExternalBackupTargetView` uses for the NAS credential.
 */
type BackupTargetView =
    | { type: 'local'; path: string }
    | { type: 'ssh'; host: string; port?: number; user: string; path: string; identityFile?: string }
    | { type: 'smb'; host: string; share: string; path?: string; username?: string; hasPassword: boolean; domain?: string }
    | { type: 'nfs'; host: string; export: string; path?: string };

export type BackupSchedule = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * A single sync source: a directory to back up plus .gitignore-style
 * exclude patterns scoped to that directory. Each source rsyncs into its
 * own subfolder under the target so per-source `--delete` can't collide.
 */
export interface BackupSource {
    path: string;            // e.g. /mnt/data
    excludePatterns?: string[];
}

export interface BackupConfig {
    enabled: boolean;
    schedule: BackupSchedule;
    time: string;       // HH:MM (UTC)
    dayOfWeek?: number; // 0-6 (Sun-Sat), for weekly
    dayOfMonth?: number; // 1-28, for monthly
    target: BackupTarget;
    /** Operator-configurable list of source dirs + per-source excludes. */
    sources?: BackupSource[];
    /** @deprecated legacy single-source fields; migrated to `sources` on read. */
    sourcePath?: string; // e.g. /mnt/data
    /** @deprecated legacy single-source excludes; migrated to `sources` on read. */
    excludePatterns?: string[];
    lastRun?: string;
    lastStatus?: 'success' | 'error';
    lastMessage?: string;
    lastDuration?: number; // seconds
}

/**
 * Normalize a config to its source list. New configs carry `sources`;
 * configs written before the multi-source change carry the legacy
 * `sourcePath`/`excludePatterns` pair — fold those into a one-element list.
 */
export function resolveBackupSources(config: BackupConfig): BackupSource[] {
    if (config.sources && config.sources.length > 0) {
        return config.sources.filter(s => s.path && s.path.trim());
    }
    if (config.sourcePath && config.sourcePath.trim()) {
        return [{ path: config.sourcePath, excludePatterns: config.excludePatterns }];
    }
    return [];
}

/** `BackupConfig` as it may be handed to a client: target secrets masked. */
export type BackupConfigView = Omit<BackupConfig, 'target'> & { target: BackupTargetView };

/** Swap an smb target's password for a `hasPassword` flag (#2771). */
function redactBackupTarget(target: BackupTarget): BackupTargetView {
    // `target?.` guards a legacy config blob that never got one — the GET used
    // to return whatever was stored, and must not start throwing on it.
    if (target?.type !== 'smb') return target;
    const { password, ...rest } = target;
    return { ...rest, hasPassword: Boolean(password) };
}

/** The whole config, safe to send to the browser (#2771). */
export function redactBackupConfig(config: BackupConfig): BackupConfigView {
    return { ...config, target: redactBackupTarget(config.target) };
}

/**
 * Fold a stored secret back into an incoming target. The form never receives
 * the live password, so a save that leaves the field untouched sends it blank
 * — that means "keep what is stored", not "clear it" (#2771). Mirrors
 * `saveExternalBackupTarget`. Switching the target away from smb drops the
 * secret, as it should.
 */
export function preserveBackupTargetSecrets(
    incoming: BackupTarget,
    existing: BackupTarget | undefined,
): BackupTarget {
    if (incoming?.type !== 'smb' || incoming.password) return incoming;
    if (existing?.type !== 'smb' || !existing.password) return incoming;
    return { ...incoming, password: existing.password };
}

export interface BackupRunResult {
    success: boolean;
    startedAt: string;
    completedAt: string;
    duration: number; // seconds
    message: string;
    bytesTransferred?: number;
    filesTransferred?: number;
}
