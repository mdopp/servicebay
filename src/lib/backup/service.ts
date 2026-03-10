// src/lib/backup/service.ts
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BackupConfig, BackupRunResult, BackupTarget } from './types';
import { getConfig, updateConfig } from '../config';
import { logger } from '../logger';
import { DATA_DIR } from '../dirs';
import { sendEmailAlert } from '../email';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const BACKUP_HISTORY_FILE = path.join(DATA_DIR, 'backup-history.json');
const SMB_MOUNT_BASE = path.join(os.tmpdir(), 'servicebay-backup-mnt');
const MAX_HISTORY_ENTRIES = 100;

let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

// ─── History Persistence ─────────────────────────────────────────────

export async function getBackupHistory(): Promise<BackupRunResult[]> {
    try {
        const content = await fs.readFile(BACKUP_HISTORY_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

async function appendHistory(result: BackupRunResult): Promise<void> {
    const history = await getBackupHistory();
    history.unshift(result);
    if (history.length > MAX_HISTORY_ENTRIES) {
        history.length = MAX_HISTORY_ENTRIES;
    }
    await fs.writeFile(BACKUP_HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ─── Target Resolution ───────────────────────────────────────────────

function buildRsyncArgs(source: string, target: BackupTarget, excludePatterns: string[]): { args: string[]; mountPath?: string; cleanup?: () => Promise<void> } {
    const args = [
        '-az',
        '--delete',
        '--stats',
        '--human-readable',
        '--timeout=300',
    ];

    for (const pattern of excludePatterns) {
        args.push('--exclude', pattern);
    }

    // Ensure source ends with /
    const src = source.endsWith('/') ? source : `${source}/`;

    switch (target.type) {
        case 'local': {
            args.push(src, target.path.endsWith('/') ? target.path : `${target.path}/`);
            return { args };
        }
        case 'ssh': {
            const sshCmd = buildSSHCommand(target);
            args.push('-e', sshCmd);
            const remotePath = target.path.endsWith('/') ? target.path : `${target.path}/`;
            args.push(src, `${target.user}@${target.host}:${remotePath}`);
            return { args };
        }
        case 'smb':
        case 'nfs': {
            // These get mounted first; rsync targets the mount point
            const mountPath = path.join(SMB_MOUNT_BASE, `backup-${Date.now()}`);
            const subPath = target.type === 'smb' ? target.path : target.path;
            const fullTarget = subPath ? path.join(mountPath, subPath) : mountPath;
            args.push(src, fullTarget.endsWith('/') ? fullTarget : `${fullTarget}/`);
            return { args, mountPath };
        }
    }
}

function buildSSHCommand(target: { host: string; port?: number; user?: string; identityFile?: string }): string {
    const parts = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];
    if (target.port) parts.push('-p', String(target.port));
    if (target.identityFile) parts.push('-i', target.identityFile);
    return parts.join(' ');
}

async function mountTarget(target: BackupTarget, mountPath: string): Promise<void> {
    await fs.mkdir(mountPath, { recursive: true });

    if (target.type === 'smb') {
        const share = `//${target.host}/${target.share}`;
        const opts: string[] = [];
        if (target.username) {
            opts.push(`username=${target.username}`);
            if (target.password) opts.push(`password=${target.password}`);
            if (target.domain) opts.push(`domain=${target.domain}`);
        } else {
            opts.push('guest');
        }
        opts.push(`uid=${process.getuid?.() ?? 1000}`);
        opts.push(`gid=${process.getgid?.() ?? 1000}`);
        opts.push('file_mode=0664', 'dir_mode=0775');

        await execAsync(`sudo mount -t cifs ${share} ${mountPath} -o ${opts.join(',')}`);
    } else if (target.type === 'nfs') {
        const nfsPath = `${target.host}:${target.export}`;
        await execAsync(`sudo mount -t nfs ${nfsPath} ${mountPath}`);
    }

    // Create subfolder if specified
    const subPath = target.type === 'smb' ? target.path : (target.type === 'nfs' ? target.path : undefined);
    if (subPath) {
        await fs.mkdir(path.join(mountPath, subPath), { recursive: true });
    }
}

async function unmountTarget(mountPath: string): Promise<void> {
    try {
        await execAsync(`sudo umount ${mountPath}`);
    } catch (e) {
        logger.warn('Backup', `Failed to unmount ${mountPath}: ${e}`);
    }
    try {
        await fs.rmdir(mountPath);
    } catch {
        // ignore
    }
}

// ─── Rsync Execution ────────────────────────────────────────────────

function parseRsyncStats(output: string): { bytesTransferred?: number; filesTransferred?: number } {
    const result: { bytesTransferred?: number; filesTransferred?: number } = {};

    const filesMatch = output.match(/Number of regular files transferred:\s*([\d,]+)/);
    if (filesMatch) result.filesTransferred = parseInt(filesMatch[1].replace(/,/g, ''));

    const bytesMatch = output.match(/Total transferred file size:\s*([\d,.]+)\s*(\w*)/);
    if (bytesMatch) {
        const num = parseFloat(bytesMatch[1].replace(/,/g, ''));
        const unit = (bytesMatch[2] || '').toLowerCase();
        const multiplier = unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1048576 : unit.startsWith('g') ? 1073741824 : 1;
        result.bytesTransferred = Math.round(num * multiplier);
    }

    return result;
}

async function ensureTargetDir(target: BackupTarget): Promise<void> {
    if (target.type === 'local') {
        await fs.mkdir(target.path, { recursive: true });
    } else if (target.type === 'ssh') {
        const sshCmd = buildSSHCommand(target);
        await execAsync(`${sshCmd} ${target.user}@${target.host} "mkdir -p ${target.path}"`);
    }
}

// ─── Main Run ────────────────────────────────────────────────────────

export async function runBackup(config?: BackupConfig): Promise<BackupRunResult> {
    if (isRunning) {
        return {
            success: false,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            duration: 0,
            message: 'Backup is already running',
        };
    }

    isRunning = true;
    const startedAt = new Date();
    let previousStatus: 'success' | 'error' | undefined;

    try {
        if (!config) {
            const appConfig = await getConfig();
            config = appConfig.backup;
            previousStatus = config?.lastStatus;
        } else {
            const appConfig = await getConfig();
            previousStatus = appConfig.backup?.lastStatus;
        }

        if (!config) {
            throw new Error('No backup configuration found');
        }

        logger.info('Backup', `Starting backup: ${config.sourcePath} → ${describeTarget(config.target)}`);

        // Verify source exists
        try {
            await fs.access(config.sourcePath);
        } catch {
            throw new Error(`Source path does not exist: ${config.sourcePath}`);
        }

        // Build rsync command
        const { args, mountPath } = buildRsyncArgs(
            config.sourcePath,
            config.target,
            config.excludePatterns || []
        );

        let mountCleanup: (() => Promise<void>) | undefined;

        try {
            // Mount if needed
            if (mountPath && (config.target.type === 'smb' || config.target.type === 'nfs')) {
                logger.info('Backup', `Mounting ${config.target.type} target at ${mountPath}`);
                await mountTarget(config.target, mountPath);
                mountCleanup = () => unmountTarget(mountPath);
            }

            // Ensure target directory exists
            await ensureTargetDir(config.target);

            // Run rsync
            logger.info('Backup', `Running: rsync ${args.join(' ')}`);
            const { stdout, stderr } = await execFileAsync('rsync', args, {
                timeout: 24 * 60 * 60 * 1000, // 24h max
                maxBuffer: 10 * 1024 * 1024, // 10MB
            });

            const completedAt = new Date();
            const duration = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
            const stats = parseRsyncStats(stdout);

            if (stderr && stderr.trim()) {
                logger.warn('Backup', `rsync stderr: ${stderr.trim()}`);
            }

            const result: BackupRunResult = {
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                duration,
                message: `Backup completed. ${stats.filesTransferred ?? '?'} files synced.`,
                ...stats,
            };

            logger.info('Backup', result.message);
            await appendHistory(result);
            await updateBackupStatus(true, result.message, duration);

            // Send recovery email if previous run failed
            if (previousStatus === 'error') {
                sendEmailAlert(
                    'Backup Recovered',
                    `Backup sync has recovered.\n\n${result.message}\nDuration: ${duration}s\nTarget: ${describeTarget(config!.target)}`
                ).catch(e => logger.warn('Backup', `Failed to send recovery email: ${e}`));
            }

            return result;
        } finally {
            if (mountCleanup) await mountCleanup();
        }
    } catch (error) {
        const completedAt = new Date();
        const duration = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
        const message = error instanceof Error ? error.message : String(error);

        logger.error('Backup', `Backup failed: ${message}`);

        const result: BackupRunResult = {
            success: false,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            duration,
            message,
        };

        await appendHistory(result);
        await updateBackupStatus(false, message, duration);

        // Send failure email (only on first failure, not repeated)
        if (previousStatus !== 'error') {
            sendEmailAlert(
                'Backup Failed',
                `Backup sync has failed.\n\nError: ${message}\nDuration: ${duration}s\nTarget: ${config ? describeTarget(config.target) : 'unknown'}`
            ).catch(e => logger.warn('Backup', `Failed to send failure email: ${e}`));
        }

        return result;
    } finally {
        isRunning = false;
    }
}

async function updateBackupStatus(success: boolean, message: string, duration: number): Promise<void> {
    try {
        const config = await getConfig();
        if (config.backup) {
            await updateConfig({
                backup: {
                    ...config.backup,
                    lastRun: new Date().toISOString(),
                    lastStatus: success ? 'success' : 'error',
                    lastMessage: message,
                    lastDuration: duration,
                }
            });
        }
    } catch (e) {
        logger.warn('Backup', `Failed to update backup status: ${e}`);
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────

function getNextRunTime(config: BackupConfig): Date {
    const now = new Date();
    const [hourStr, minuteStr] = (config.time || '02:00').split(':');
    const hour = Number(hourStr) || 0;
    const minute = Number(minuteStr) || 0;

    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCHours(hour, minute);

    switch (config.schedule) {
        case 'hourly':
            next.setUTCHours(now.getUTCHours(), minute);
            if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
            break;

        case 'daily':
            if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
            break;

        case 'weekly': {
            const targetDay = config.dayOfWeek ?? 0; // Sunday default
            let daysUntil = targetDay - now.getUTCDay();
            if (daysUntil < 0) daysUntil += 7;
            if (daysUntil === 0 && next <= now) daysUntil = 7;
            next.setUTCDate(next.getUTCDate() + daysUntil);
            break;
        }

        case 'monthly': {
            const targetDay = config.dayOfMonth ?? 1;
            next.setUTCDate(targetDay);
            if (next <= now) {
                next.setUTCMonth(next.getUTCMonth() + 1);
                next.setUTCDate(targetDay);
            }
            break;
        }
    }

    return next;
}

export function scheduleBackup(): void {
    if (scheduledTimer) {
        clearTimeout(scheduledTimer);
        scheduledTimer = null;
    }

    getConfig().then(appConfig => {
        const config = appConfig.backup;
        if (!config?.enabled) {
            logger.info('Backup', 'Scheduled backup disabled');
            return;
        }

        const nextRun = getNextRunTime(config);
        const delayMs = nextRun.getTime() - Date.now();

        logger.info('Backup', `Next backup scheduled at ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);

        scheduledTimer = setTimeout(async () => {
            try {
                await runBackup(config);
            } catch (e) {
                logger.error('Backup', `Scheduled backup failed: ${e}`);
            } finally {
                // Reschedule
                scheduleBackup();
            }
        }, delayMs);
    }).catch(e => {
        logger.error('Backup', `Failed to schedule backup: ${e}`);
    });
}

export function isBackupRunning(): boolean {
    return isRunning;
}

// ─── Test Connection ────────────────────────────────────────────────

export async function testBackupTarget(target: BackupTarget): Promise<{ success: boolean; message: string }> {
    try {
        switch (target.type) {
            case 'local': {
                await fs.access(target.path);
                const stats = await fs.stat(target.path);
                if (!stats.isDirectory()) {
                    return { success: false, message: `${target.path} is not a directory` };
                }
                // Test write access
                const testFile = path.join(target.path, '.servicebay-backup-test');
                await fs.writeFile(testFile, 'test');
                await fs.unlink(testFile);
                return { success: true, message: `Directory ${target.path} is accessible and writable` };
            }

            case 'ssh': {
                const sshCmd = buildSSHCommand(target);
                await execAsync(`${sshCmd} ${target.user}@${target.host} "mkdir -p ${target.path} && echo ok"`);
                return { success: true, message: `SSH connection to ${target.host} successful, path writable` };
            }

            case 'smb': {
                const mountPath = path.join(SMB_MOUNT_BASE, `test-${Date.now()}`);
                try {
                    await mountTarget({ ...target, path: undefined } as BackupTarget, mountPath);
                    return { success: true, message: `SMB share //${target.host}/${target.share} mounted successfully` };
                } finally {
                    await unmountTarget(mountPath);
                }
            }

            case 'nfs': {
                const mountPath = path.join(SMB_MOUNT_BASE, `test-${Date.now()}`);
                try {
                    await mountTarget({ ...target, path: undefined } as BackupTarget, mountPath);
                    return { success: true, message: `NFS export ${target.host}:${target.export} mounted successfully` };
                } finally {
                    await unmountTarget(mountPath);
                }
            }

            default:
                return { success: false, message: `Unknown target type` };
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, message: msg };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function describeTarget(target: BackupTarget): string {
    switch (target.type) {
        case 'local': return `Local: ${target.path}`;
        case 'ssh': return `SSH: ${target.user}@${target.host}:${target.path}`;
        case 'smb': return `SMB: //${target.host}/${target.share}${target.path ? `/${target.path}` : ''}`;
        case 'nfs': return `NFS: ${target.host}:${target.export}${target.path ? `/${target.path}` : ''}`;
    }
}
