// src/lib/backup/types.ts

export type BackupTarget =
    | { type: 'local'; path: string }
    | { type: 'ssh'; host: string; port?: number; user: string; path: string; identityFile?: string }
    | { type: 'smb'; host: string; share: string; path?: string; username?: string; password?: string; domain?: string }
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

export interface BackupRunResult {
    success: boolean;
    startedAt: string;
    completedAt: string;
    duration: number; // seconds
    message: string;
    bytesTransferred?: number;
    filesTransferred?: number;
}
