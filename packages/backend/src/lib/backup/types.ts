// src/lib/backup/types.ts

export type BackupTarget =
    | { type: 'local'; path: string }
    | { type: 'ssh'; host: string; port?: number; user: string; path: string; identityFile?: string }
    | { type: 'smb'; host: string; share: string; path?: string; username?: string; password?: string; domain?: string }
    | { type: 'nfs'; host: string; export: string; path?: string };

export type BackupSchedule = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface BackupConfig {
    enabled: boolean;
    schedule: BackupSchedule;
    time: string;       // HH:MM (UTC)
    dayOfWeek?: number; // 0-6 (Sun-Sat), for weekly
    dayOfMonth?: number; // 1-28, for monthly
    target: BackupTarget;
    sourcePath: string; // e.g. /mnt/data
    excludePatterns?: string[];
    lastRun?: string;
    lastStatus?: 'success' | 'error';
    lastMessage?: string;
    lastDuration?: number; // seconds
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
