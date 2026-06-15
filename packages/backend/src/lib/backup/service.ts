// src/lib/backup/service.ts
import { execFile } from 'node:child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BackupConfig, BackupRunResult, BackupSource, BackupTarget, resolveBackupSources } from './types';
import { getConfig, updateConfig } from '../config';
import { logger } from '../logger';
import { DATA_DIR } from '../dirs';
import { sendEmailAlert } from '../email';
import { atomicWriteFile } from '../util/atomicWrite';

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

// Per-process serialization for backup-history mutations. Concurrent
// backups completing at the same time would otherwise race here:
// both read the same history, both prepend their own result, both
// write — second clobbers the first. Same Promise-chain pattern as
// updateConfig (#299), NetworkStore (#300), nodes (#301).
let historyWriteQueue: Promise<unknown> = Promise.resolve();
function withHistoryLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = historyWriteQueue.then(fn, fn);
    historyWriteQueue = next.catch(() => undefined);
    return next;
}

async function appendHistory(result: BackupRunResult): Promise<void> {
    return withHistoryLock(async () => {
        const history = await getBackupHistory();
        history.unshift(result);
        if (history.length > MAX_HISTORY_ENTRIES) {
            history.length = MAX_HISTORY_ENTRIES;
        }
        await atomicWriteFile(BACKUP_HISTORY_FILE, JSON.stringify(history, null, 2));
    });
}

// ─── Target Resolution ───────────────────────────────────────────────

function withTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}

// Append a per-source subfolder to a target path. With a single source we
// keep the legacy flat layout (subFolder undefined) so existing backups
// aren't orphaned; with multiple sources each gets its own subdirectory so
// rsync `--delete` can't wipe a sibling source's data.
function joinTargetPath(base: string, subFolder?: string): string {
    return subFolder ? path.posix.join(base, subFolder) : base;
}

export function buildRsyncArgs(
    source: string,
    target: BackupTarget,
    excludePatterns: string[],
    subFolder?: string,
    mountPath?: string,
): { args: string[]; mountPath?: string } {
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
    const src = withTrailingSlash(source);

    switch (target.type) {
        case 'local': {
            args.push(src, withTrailingSlash(joinTargetPath(target.path, subFolder)));
            return { args };
        }
        case 'ssh': {
            const sshCmd = buildSSHCommand(target);
            args.push('-e', sshCmd);
            const remotePath = withTrailingSlash(joinTargetPath(target.path, subFolder));
            args.push(src, `${target.user}@${target.host}:${remotePath}`);
            return { args };
        }
        case 'smb':
        case 'nfs': {
            // These get mounted first; rsync targets the mount point. The
            // mount is shared across sources within one run (passed in).
            const resolvedMount = mountPath ?? path.join(SMB_MOUNT_BASE, `backup-${Date.now()}`);
            const subPath = target.path;
            const baseTarget = subPath ? path.join(resolvedMount, subPath) : resolvedMount;
            const fullTarget = joinTargetPath(baseTarget, subFolder);
            args.push(src, withTrailingSlash(fullTarget));
            return { args, mountPath: resolvedMount };
        }
    }
}

function buildSSHCommand(target: { host: string; port?: number; user?: string; identityFile?: string }): string {
    // Used as the `-e` argument to rsync, which expects a shell-tokenized string.
    const parts = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];
    if (target.port) parts.push('-p', String(target.port));
    if (target.identityFile) parts.push('-i', target.identityFile);
    return parts.join(' ');
}

function buildSSHArgv(target: { host: string; port?: number; user?: string; identityFile?: string }): string[] {
    const argv = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];
    if (target.port) argv.push('-p', String(target.port));
    if (target.identityFile) argv.push('-i', target.identityFile);
    return argv;
}

// Write a mount.cifs `credentials=` file (username/password/domain lines) into
// a private 0700 temp dir, with the file itself at 0600. Returns its absolute
// path. Using a credentials file — rather than `password=<pw>` inline in the
// comma-joined `-o` options — means a password containing commas, newlines or
// `=` is passed verbatim and cannot inject extra mount options.
async function writeCifsCredentialsFile(
    username: string,
    password?: string,
    domain?: string,
): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-cifs-'));
    const file = path.join(dir, 'credentials');
    const lines = [`username=${username}`];
    if (password) lines.push(`password=${password}`);
    if (domain) lines.push(`domain=${domain}`);
    // mode 0600 from creation; the enclosing mkdtemp dir is already 0700.
    await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    return file;
}

async function removeCifsCredentialsFile(file: string): Promise<void> {
    try {
        await fs.rm(path.dirname(file), { recursive: true, force: true });
    } catch (e) {
        logger.warn('Backup', `Failed to remove CIFS credentials file: ${e}`);
    }
}

async function mountTarget(target: BackupTarget, mountPath: string): Promise<void> {
    await fs.mkdir(mountPath, { recursive: true });

    if (target.type === 'smb') {
        const share = `//${target.host}/${target.share}`;
        const opts: string[] = [];
        // Credentials never go inline in the comma-joined `-o` options: a comma
        // (or newline) in a password would terminate the value and let an
        // attacker inject arbitrary mount options (e.g. uid=0). Instead we hand
        // mount.cifs a 0600 `credentials=` file — the standard mechanism — so
        // the password is passed verbatim and can't break out of the option list.
        let credentialsFile: string | undefined;
        if (target.username) {
            credentialsFile = await writeCifsCredentialsFile(target.username, target.password, target.domain);
            opts.push(`credentials=${credentialsFile}`);
        } else {
            opts.push('guest');
        }
        opts.push(`uid=${process.getuid?.() ?? 1000}`);
        opts.push(`gid=${process.getgid?.() ?? 1000}`);
        opts.push('file_mode=0664', 'dir_mode=0775');

        try {
            await execFileAsync('sudo', ['mount', '-t', 'cifs', share, mountPath, '-o', opts.join(',')]);
        } finally {
            // The credentials file is only needed for the duration of the mount
            // call; mount.cifs reads it synchronously, so remove it immediately
            // (along with its private temp dir) regardless of success/failure.
            if (credentialsFile) await removeCifsCredentialsFile(credentialsFile);
        }
    } else if (target.type === 'nfs') {
        const nfsPath = `${target.host}:${target.export}`;
        await execFileAsync('sudo', ['mount', '-t', 'nfs', nfsPath, mountPath]);
    }

    // Create subfolder if specified
    const subPath = target.type === 'smb' ? target.path : (target.type === 'nfs' ? target.path : undefined);
    if (subPath) {
        await fs.mkdir(path.join(mountPath, subPath), { recursive: true });
    }
}

async function unmountTarget(mountPath: string): Promise<void> {
    try {
        await execFileAsync('sudo', ['umount', mountPath]);
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

/**
 * Validate a Local/USB target. Shared by Test Connection and Run so the two
 * can never diverge (#1612). The target must ALREADY exist and be a directory
 * — we never `mkdir` it, because a silently-created dir means a non-mounted
 * mountpoint, which rsyncs straight onto the OS/boot disk. When `sources` are
 * supplied we additionally refuse a target on the same filesystem/device as
 * any source: a same-disk "backup" is pointless and is exactly what the old
 * silent mkdir produced.
 */
async function validateLocalTarget(targetPath: string, sources?: BackupSource[]): Promise<void> {
    let targetStats;
    try {
        targetStats = await fs.stat(targetPath);
    } catch {
        throw new Error(`ENOENT: no such file or directory, access '${targetPath}'`);
    }
    if (!targetStats.isDirectory()) {
        throw new Error(`${targetPath} is not a directory`);
    }
    if (!sources || sources.length === 0) return;
    for (const source of sources) {
        let sourceStats;
        try {
            sourceStats = await fs.stat(source.path);
        } catch {
            continue; // a missing source is rsyncOneSource's problem, not ours
        }
        if (sourceStats.dev === targetStats.dev) {
            throw new Error(
                `Backup target ${targetPath} is on the same filesystem as source ${source.path} ` +
                `(likely nothing is mounted there) — refusing to back up onto the same disk.`
            );
        }
    }
}

async function ensureTargetDir(target: BackupTarget, sources?: BackupSource[]): Promise<void> {
    if (target.type === 'local') {
        await validateLocalTarget(target.path, sources);
    } else if (target.type === 'ssh') {
        const [sshBin, ...sshArgs] = buildSSHArgv(target);
        await execFileAsync(sshBin, [...sshArgs, `${target.user}@${target.host}`, 'mkdir', '-p', target.path]);
    }
}

// ─── Main Run ────────────────────────────────────────────────────────

// Assign each source a stable, unique subfolder name under the target.
// With a single source we keep the legacy flat layout (no subfolder).
// With multiple sources we use the basename, disambiguating collisions
// (e.g. two `data` dirs) with a numeric suffix.
export function assignSourceSubFolders(sources: BackupSource[]): { source: BackupSource; subFolder?: string }[] {
    if (sources.length <= 1) {
        return sources.map(source => ({ source }));
    }
    const used = new Set<string>();
    return sources.map(source => {
        const base = path.basename(source.path.replace(/\/+$/, '')) || 'root';
        let name = base;
        let n = 2;
        while (used.has(name)) {
            name = `${base}-${n++}`;
        }
        used.add(name);
        return { source, subFolder: name };
    });
}

// Run rsync for one source and return its parsed stats. Mounting and the
// shared mount cleanup are the caller's responsibility.
async function rsyncOneSource(
    source: BackupSource,
    target: BackupTarget,
    subFolder: string | undefined,
    mountPath: string | undefined,
): Promise<{ bytesTransferred?: number; filesTransferred?: number }> {
    try {
        await fs.access(source.path);
    } catch {
        throw new Error(`Source path does not exist: ${source.path}`);
    }

    const { args } = buildRsyncArgs(source.path, target, source.excludePatterns || [], subFolder, mountPath);

    logger.info('Backup', `Running: rsync ${args.join(' ')}`);
    const { stdout, stderr } = await execFileAsync('rsync', args, {
        timeout: 24 * 60 * 60 * 1000, // 24h max
        maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    if (stderr && stderr.trim()) {
        logger.warn('Backup', `rsync stderr: ${stderr.trim()}`);
    }
    return parseRsyncStats(stdout);
}

async function runBackupItems(
    config: BackupConfig,
    startedAt: Date,
    previousStatus: 'success' | 'error' | undefined
): Promise<BackupRunResult> {
    const sources = resolveBackupSources(config);
    if (sources.length === 0) {
        throw new Error('No backup sources configured');
    }
    logger.info('Backup', `Starting backup: ${sources.map(s => s.path).join(', ')} → ${describeTarget(config.target)}`);

    const assigned = assignSourceSubFolders(sources);

    // Mount once per run (smb/nfs); reused across every source.
    let mountCleanup: (() => Promise<void>) | undefined;
    let sharedMountPath: string | undefined;
    if (config.target.type === 'smb' || config.target.type === 'nfs') {
        sharedMountPath = path.join(SMB_MOUNT_BASE, `backup-${Date.now()}`);
        logger.info('Backup', `Mounting ${config.target.type} target at ${sharedMountPath}`);
        await mountTarget(config.target, sharedMountPath);
        mountCleanup = () => unmountTarget(sharedMountPath!);
    }

    try {
        await ensureTargetDir(config.target, sources);

        let totalBytes = 0;
        let totalFiles = 0;
        for (const { source, subFolder } of assigned) {
            const stats = await rsyncOneSource(source, config.target, subFolder, sharedMountPath);
            totalBytes += stats.bytesTransferred ?? 0;
            totalFiles += stats.filesTransferred ?? 0;
        }

        return await recordBackupSuccess(config, startedAt, sources.length, totalBytes, totalFiles, previousStatus);
    } finally {
        if (mountCleanup) await mountCleanup();
    }
}

async function recordBackupSuccess(
    config: BackupConfig,
    startedAt: Date,
    sourceCount: number,
    totalBytes: number,
    totalFiles: number,
    previousStatus: 'success' | 'error' | undefined,
): Promise<BackupRunResult> {
    const completedAt = new Date();
    const duration = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
    const result: BackupRunResult = {
        success: true,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        duration,
        message: `Backup completed. ${totalFiles} files synced from ${sourceCount} source${sourceCount === 1 ? '' : 's'}.`,
        bytesTransferred: totalBytes,
        filesTransferred: totalFiles,
    };

    logger.info('Backup', result.message);
    await appendHistory(result);
    await updateBackupStatus(true, result.message, duration);

    if (previousStatus === 'error') {
        sendEmailAlert(
            'Backup Recovered',
            `Backup sync has recovered.\n\n${result.message}\nDuration: ${duration}s\nTarget: ${describeTarget(config.target)}`
        ).catch(e => logger.warn('Backup', `Failed to send recovery email: ${e}`));
    }

    return result;
}

async function loadBackupConfig(config?: BackupConfig): Promise<{ config: BackupConfig; previousStatus?: 'success' | 'error' }> {
    if (!config) {
        const appConfig = await getConfig();
        return { config: appConfig.backup!, previousStatus: appConfig.backup?.lastStatus };
    }
    const appConfig = await getConfig();
    return { config, previousStatus: appConfig.backup?.lastStatus };
}

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
    let resolvedConfig: BackupConfig | undefined;
    let previousStatus: 'success' | 'error' | undefined;

    try {
        const loaded = await loadBackupConfig(config);
        resolvedConfig = loaded.config;
        previousStatus = loaded.previousStatus;
        return await runBackupItems(resolvedConfig, startedAt, previousStatus);
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

        if (previousStatus !== 'error') {
            const target = resolvedConfig ? describeTarget(resolvedConfig.target) : 'unknown';
            sendEmailAlert(
                'Backup Failed',
                `Backup sync has failed.\n\nError: ${message}\nDuration: ${duration}s\nTarget: ${target}`
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

function getNextDateForSchedule(now: Date, schedule: string, dayOfWeek?: number, dayOfMonth?: number): Date {
    const next = new Date(now);
    switch (schedule) {
        case 'hourly':
            if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
            break;
        case 'daily':
            if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
            break;
        case 'weekly': {
            const targetDay = dayOfWeek ?? 0;
            let daysUntil = targetDay - now.getUTCDay();
            if (daysUntil < 0) daysUntil += 7;
            if (daysUntil === 0 && next <= now) daysUntil = 7;
            next.setUTCDate(next.getUTCDate() + daysUntil);
            break;
        }
        case 'monthly': {
            const targetDay = dayOfMonth ?? 1;
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

function getNextRunTime(config: BackupConfig): Date {
    const now = new Date();
    const [hourStr, minuteStr] = (config.time || '02:00').split(':');
    const hour = Number(hourStr) || 0;
    const minute = Number(minuteStr) || 0;

    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCHours(hour, minute);

    return getNextDateForSchedule(next, config.schedule, config.dayOfWeek, config.dayOfMonth);
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

export async function testBackupTarget(target: BackupTarget, sources?: BackupSource[]): Promise<{ success: boolean; message: string }> {
    try {
        switch (target.type) {
            case 'local': {
                await validateLocalTarget(target.path, sources);
                // Test write access
                const testFile = path.join(target.path, '.servicebay-backup-test');
                await fs.writeFile(testFile, 'test');
                await fs.unlink(testFile);
                return { success: true, message: `Directory ${target.path} is accessible and writable` };
            }

            case 'ssh': {
                const [sshBin, ...sshArgs] = buildSSHArgv(target);
                // Use a fixed sentinel command to verify connectivity + path writability.
                await execFileAsync(sshBin, [
                    ...sshArgs,
                    `${target.user}@${target.host}`,
                    'sh', '-c', 'mkdir -p "$1" && echo ok', '--', target.path,
                ]);
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
