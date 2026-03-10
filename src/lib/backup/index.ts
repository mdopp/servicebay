export type { BackupConfig, BackupTarget, BackupRunResult, BackupSchedule, BackupTargetType } from './types';
export { DEFAULT_BACKUP_CONFIG } from './types';
export { runBackup, scheduleBackup, cancelScheduledBackup, isBackupRunning, testBackupTarget, getBackupHistory, describeTarget } from './service';
