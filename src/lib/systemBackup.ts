import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client, SFTPWrapper } from 'ssh2';
import { DATA_DIR, SERVICEBAY_BACKUP_DIR, getLocalSystemdDir } from './dirs';
import { logger } from './logger';
import { listNodes, PodmanConnection } from './nodes';
import { SSHConnectionPool } from './ssh/pool';
import { getConfig, updateConfig } from './config';

const execFileAsync = promisify(execFile);
const BACKUP_PREFIX = 'servicebay-full';
const CONFIG_FILES = ['config.json', 'nodes.json', 'checks.json'];
const REMOTE_SYSTEMD_DIR = '$HOME/.config/containers/systemd';
const METADATA_FILE = 'metadata.json';
const METADATA_VERSION = 1;

export interface SystemBackupEntry {
    fileName: string;
    path: string;
    createdAt: string;
    size: number;
}

export type BackupLogStatus = 'info' | 'success' | 'error' | 'skip';

export interface BackupLogEntry {
    timestamp: string;
    scope: 'config' | 'local' | 'remote' | 'archive' | 'cleanup';
    message: string;
    status: BackupLogStatus;
    node?: string;
    target?: string;
}

export interface SystemBackupResult {
    entry: SystemBackupEntry;
    log: BackupLogEntry[];
}

interface BackupPreviewNode {
    name: string;
    uri?: string;
    identity?: string;
    default?: boolean;
}

interface BackupPreviewCheck {
    id: string;
    name: string;
    type?: string;
    target?: string;
}

interface BackupPreviewExternalLink {
    name: string;
    url: string;
}

interface BackupPreviewRegistry {
    name: string;
    url?: string;
    branch?: string;
}

interface BackupPreviewGateway {
    type?: string;
    host?: string;
}

interface BackupPreviewNotification {
    host?: string;
    from?: string;
    to?: string[];
}

export interface BackupPreviewConfig {
    nodes: BackupPreviewNode[];
    checks: BackupPreviewCheck[];
    externalLinks: BackupPreviewExternalLink[];
    registries: BackupPreviewRegistry[];
    gateway?: BackupPreviewGateway;
    notifications?: BackupPreviewNotification;
    templateSettings: string[];
    logLevel?: string;
    update?: {
        enabled?: boolean;
        schedule?: string;
        channel?: string;
    };
}

interface BackupPreviewNodeFile {
    relativePath: string;
    fileName: string;
}

export interface BackupPreviewNodeFiles {
    nodeName: string;
    files: BackupPreviewNodeFile[];
}

export interface BackupPreviewResult {
    config: BackupPreviewConfig;
    nodeFiles: BackupPreviewNodeFiles[];
}

export interface BackupRestoreSelection {
    config: {
        nodes?: string[];
        checks?: string[];
        externalLinks?: boolean;
        registries?: boolean;
        gateway?: boolean;
        notifications?: boolean;
        templateSettings?: boolean;
        logLevel?: boolean;
        update?: boolean;
    };
    nodeFiles: Array<{
        sourceNode: string;
        targetNode: string;
        files: string[];
    }>;
}

interface BackupNodeDescriptor {
    name: string;
    folder: string;
    scope: 'local' | 'remote';
}

interface BackupMetadata {
    version: number;
    createdAt: string;
    nodes: BackupNodeDescriptor[];
    configFiles: string[];
}

type ProgressCallback = (entry: BackupLogEntry) => void;

async function ensureBackupDir() {
    await fs.mkdir(SERVICEBAY_BACKUP_DIR, { recursive: true });
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

function sanitizeBackupName(fileName: string): string {
    const safeName = path.basename(fileName);
    if (!safeName.startsWith(BACKUP_PREFIX) || !safeName.endsWith('.tar.gz')) {
        throw new Error('Invalid backup name');
    }
    if (safeName.includes('..')) {
        throw new Error('Invalid backup name');
    }
    return safeName;
}

async function runTar(args: string[]) {
    try {
        await execFileAsync('tar', args);
    } catch (error) {
        throw new Error(`tar command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function pushLog(logs: BackupLogEntry[], progress: ProgressCallback | undefined, entry: Omit<BackupLogEntry, 'timestamp'>) {
    const payload: BackupLogEntry = {
        ...entry,
        timestamp: new Date().toISOString()
    };
    logs.push(payload);
    progress?.(payload);
}

async function copyFileIfExists(source: string, destination: string): Promise<boolean> {
    if (!(await pathExists(source))) {
        return false;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return true;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true });
}

function encodeNodeFolder(name: string): string {
    return Buffer.from(name, 'utf8').toString('base64url');
}

function decodeNodeFolder(folder: string): string {
    try {
        return Buffer.from(folder, 'base64url').toString('utf8');
    } catch {
        return folder;
    }
}

function sanitizeRelativePath(relativePath: string): string {
    const normalized = path.posix.normalize(relativePath).replace(/^(\.\/)+/, '');
    if (!normalized || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
        throw new Error('Invalid file path');
    }
    return normalized;
}

async function execRemoteCommand(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk: Buffer | string) => {
                stdout += chunk.toString();
            });
            stream.stderr?.on('data', (chunk: Buffer | string) => {
                stderr += chunk.toString();
            });
            stream.on('close', (code: number | undefined) => {
                resolve({ stdout, stderr, code: code ?? 0 });
            });
            stream.on('error', reject);
        });
    });
}

async function withSftp<T>(conn: Client, handler: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        conn.sftp(async (err, sftp) => {
            if (err) {
                reject(err);
                return;
            }
            try {
                const result = await handler(sftp);
                sftp.end();
                resolve(result);
            } catch (error) {
                try {
                    sftp.end();
                } catch {
                    // ignore cleanup errors
                }
                reject(error);
            }
        });
    });
}

async function downloadRemoteFile(conn: Client, remotePath: string, localPath: string): Promise<void> {
    await withSftp(conn, sftp => new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
            if (err) reject(err);
            else resolve(undefined);
        });
    }));
}

async function uploadRemoteFile(conn: Client, localPath: string, remotePath: string): Promise<void> {
    await withSftp(conn, sftp => new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => {
            if (err) reject(err);
            else resolve(undefined);
        });
    }));
}

async function stageLocalSystemd(destination: string): Promise<boolean> {
    const localDir = getLocalSystemdDir();
    if (!(await pathExists(localDir))) {
        return false;
    }
    await copyDirectory(localDir, destination);
    return true;
}

async function stageRemoteSystemd(node: PodmanConnection, destination: string): Promise<'copied' | 'missing'> {
    const conn = await SSHConnectionPool.getInstance().getConnection(node.Name);
    const script = [
        'set -e',
        `target=${REMOTE_SYSTEMD_DIR}`,
        'if [ ! -d "$target" ]; then',
        '  echo "SYSTEMD_DIR_MISSING" >&2',
        '  exit 44',
        'fi',
        'tmpfile=$(mktemp /tmp/servicebay-systemd-XXXXXX.tar.gz)',
        'tar -czf "$tmpfile" -C "$target" .',
        'echo "$tmpfile"'
    ].join('\n');
    const result = await execRemoteCommand(conn, script);
    if (result.code === 44) {
        return 'missing';
    }
    if (result.code !== 0) {
        throw new Error(result.stderr || `Remote backup failed for ${node.Name}`);
    }

    const remoteTemp = result.stdout.trim().split('\n').pop();
    if (!remoteTemp) {
        throw new Error(`Remote backup for ${node.Name} did not produce an archive path`);
    }

    const localTemp = path.join(destination, 'systemd.tgz');
    await fs.mkdir(destination, { recursive: true });
    await downloadRemoteFile(conn, remoteTemp, localTemp);
    await execRemoteCommand(conn, `rm -f "${remoteTemp}"`);
    await runTar(['-xzf', localTemp, '-C', destination]);
    await fs.rm(localTemp, { force: true });
    return 'copied';
}

async function readMetadata(stagingDir: string): Promise<BackupMetadata | undefined> {
    const metadataPath = path.join(stagingDir, METADATA_FILE);
    if (!(await pathExists(metadataPath))) {
        return undefined;
    }
    try {
        const raw = await fs.readFile(metadataPath, 'utf-8');
        return JSON.parse(raw) as BackupMetadata;
    } catch (error) {
        logger.warn('SystemBackup', 'Failed to parse backup metadata', error);
        return undefined;
    }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
    if (!(await pathExists(filePath))) return undefined;
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

async function listFilesRecursive(baseDir: string): Promise<string[]> {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFilesRecursive(fullPath)));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

async function restoreConfigFiles(sourceDir: string) {
    if (!(await pathExists(sourceDir))) return;
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (const fileName of CONFIG_FILES) {
        const backupFile = path.join(sourceDir, fileName);
        if (await pathExists(backupFile)) {
            await fs.copyFile(backupFile, path.join(DATA_DIR, fileName));
        }
    }
}

async function restoreLocalSystemd(sourceDir: string) {
    if (!(await pathExists(sourceDir))) return;
    await copyDirectory(sourceDir, getLocalSystemdDir());
}

async function resolveRemoteSystemdDir(conn: Client): Promise<string> {
    const home = await execRemoteCommand(conn, 'printf "%s" "$HOME"');
    if (home.code !== 0) {
        throw new Error(home.stderr || 'Failed to resolve remote home directory');
    }
    const trimmed = home.stdout.trim();
    if (!trimmed) {
        throw new Error('Remote home directory is empty');
    }
    return path.posix.join(trimmed, '.config', 'containers', 'systemd');
}

async function restoreRemoteSystemd(node: PodmanConnection, sourceDir: string) {
    if (!(await pathExists(sourceDir))) return;
    const conn = await SSHConnectionPool.getInstance().getConnection(node.Name);
    const localArchive = path.join(sourceDir, 'systemd.tgz');
    await runTar(['-czf', localArchive, '-C', sourceDir, '.']);
    const mktemp = await execRemoteCommand(conn, 'mktemp /tmp/servicebay-systemd-restore-XXXXXX.tar.gz');
    if (mktemp.code !== 0) {
        await fs.rm(localArchive, { force: true });
        throw new Error(mktemp.stderr || `Failed to allocate remote temp file for ${node.Name}`);
    }
    const remoteTemp = mktemp.stdout.trim();
    await uploadRemoteFile(conn, localArchive, remoteTemp);
    await fs.rm(localArchive, { force: true });

    const extractScript = [
        'set -e',
        `target=${REMOTE_SYSTEMD_DIR}`,
        'mkdir -p "$target"',
        `tar -xzf "${remoteTemp}" -C "$target"`,
        `rm -f "${remoteTemp}"`
    ].join('\n');
    const extract = await execRemoteCommand(conn, extractScript);
    if (extract.code !== 0) {
        throw new Error(extract.stderr || `Failed to restore services on ${node.Name}`);
    }

    const reload = await execRemoteCommand(conn, 'systemctl --user daemon-reload');
    if (reload.code !== 0) {
        logger.warn('SystemBackup', `Remote daemon reload failed on ${node.Name}: ${reload.stderr || reload.stdout}`);
    }
}

export async function listSystemBackups(): Promise<SystemBackupEntry[]> {
    await ensureBackupDir();
    const items = await fs.readdir(SERVICEBAY_BACKUP_DIR);
    const candidates = items.filter(item => item.startsWith(BACKUP_PREFIX) && item.endsWith('.tar.gz'));
    const entries: SystemBackupEntry[] = [];

    for (const fileName of candidates) {
        const archivePath = path.join(SERVICEBAY_BACKUP_DIR, fileName);
        const stats = await fs.stat(archivePath);
        entries.push({
            fileName,
            path: archivePath,
            createdAt: stats.mtime.toISOString(),
            size: stats.size
        });
    }

    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBackupFileMeta(fileName: string): Promise<SystemBackupEntry> {
    await ensureBackupDir();
    const safeName = sanitizeBackupName(fileName);
    const archivePath = path.join(SERVICEBAY_BACKUP_DIR, safeName);
    const stats = await fs.stat(archivePath);
    return {
        fileName: safeName,
        path: archivePath,
        createdAt: stats.mtime.toISOString(),
        size: stats.size
    };
}

export async function deleteSystemBackup(fileName: string): Promise<void> {
    const entry = await getBackupFileMeta(fileName);
    await fs.unlink(entry.path);
}

export async function createSystemBackup(progress?: ProgressCallback): Promise<SystemBackupResult> {
    await ensureBackupDir();
    const logs: BackupLogEntry[] = [];
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-backup-'));
    const metadata: BackupMetadata = {
        version: METADATA_VERSION,
        createdAt: new Date().toISOString(),
        nodes: [],
        configFiles: [...CONFIG_FILES]
    };
    let stagedSomething = false;

    try {
        const configDir = path.join(stagingDir, 'config');
        await fs.mkdir(configDir, { recursive: true });
        pushLog(logs, progress, { scope: 'config', status: 'info', message: 'Collecting ServiceBay configuration files' });
        for (const fileName of CONFIG_FILES) {
            const copied = await copyFileIfExists(path.join(DATA_DIR, fileName), path.join(configDir, fileName));
            if (copied) {
                stagedSomething = true;
                pushLog(logs, progress, { scope: 'config', status: 'success', message: `Included ${fileName}` });
            } else {
                pushLog(logs, progress, { scope: 'config', status: 'skip', message: `Skipped ${fileName} (not found)` });
            }
        }

        const nodesDir = path.join(stagingDir, 'nodes');
        await fs.mkdir(nodesDir, { recursive: true });

        const localFolder = encodeNodeFolder('Local');
        const localDestination = path.join(nodesDir, localFolder, 'systemd');
        if (await stageLocalSystemd(localDestination)) {
            stagedSomething = true;
            metadata.nodes.push({ name: 'Local', folder: localFolder, scope: 'local' });
            pushLog(logs, progress, { scope: 'local', status: 'success', node: 'Local', message: 'Captured local managed services' });
        } else {
            pushLog(logs, progress, { scope: 'local', status: 'skip', node: 'Local', message: 'No local managed services found' });
        }

        const nodes = await listNodes();
        const remoteNodes = nodes.filter(node => node.URI?.startsWith('ssh://'));
        for (const node of remoteNodes) {
            const folder = encodeNodeFolder(node.Name);
            const destination = path.join(nodesDir, folder, 'systemd');
            pushLog(logs, progress, { scope: 'remote', status: 'info', node: node.Name, message: `Collecting services from ${node.Name}` });
            try {
                const result = await stageRemoteSystemd(node, destination);
                if (result === 'missing') {
                    pushLog(logs, progress, { scope: 'remote', status: 'skip', node: node.Name, message: 'No systemd directory found on remote node' });
                    continue;
                }
                stagedSomething = true;
                metadata.nodes.push({ name: node.Name, folder, scope: 'remote' });
                pushLog(logs, progress, { scope: 'remote', status: 'success', node: node.Name, message: `Captured services from ${node.Name}` });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pushLog(logs, progress, { scope: 'remote', status: 'error', node: node.Name, message });
                throw new Error(`Failed to backup ${node.Name}: ${message}`);
            }
        }

        if (!stagedSomething) {
            throw new Error('Nothing to backup');
        }

        await fs.writeFile(path.join(stagingDir, METADATA_FILE), JSON.stringify(metadata, null, 2));

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${BACKUP_PREFIX}-${timestamp}.tar.gz`;
        const archivePath = path.join(SERVICEBAY_BACKUP_DIR, fileName);
        pushLog(logs, progress, { scope: 'archive', status: 'info', message: 'Creating compressed archive' });
        await runTar(['-czf', archivePath, '-C', stagingDir, '.']);
        pushLog(logs, progress, { scope: 'archive', status: 'success', message: 'Backup archive ready', target: archivePath });

        const entry = await getBackupFileMeta(fileName);
        return { entry, log: logs };
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function restoreSystemBackup(fileName: string): Promise<SystemBackupEntry> {
    const entry = await getBackupFileMeta(fileName);
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-restore-'));
    try {
        await runTar(['-xzf', entry.path, '-C', stagingDir]);
        await restoreConfigFiles(path.join(stagingDir, 'config'));

        const nodesFromDisk = await listNodes();
        const nodesMap = new Map(nodesFromDisk.map(node => [node.Name, node]));
        const metadata = await readMetadata(stagingDir);
        const nodesDir = path.join(stagingDir, 'nodes');
        if (await pathExists(nodesDir)) {
            const entries = await fs.readdir(nodesDir, { withFileTypes: true });
            for (const dirent of entries) {
                if (!dirent.isDirectory()) continue;
                const folder = dirent.name;
                const nodeName = metadata?.nodes.find(n => n.folder === folder)?.name ?? decodeNodeFolder(folder);
                const sourceDir = path.join(nodesDir, folder, 'systemd');
                if (nodeName === 'Local') {
                    await restoreLocalSystemd(sourceDir);
                } else {
                    const node = nodesMap.get(nodeName);
                    if (!node) {
                        logger.warn('SystemBackup', `Skipping restore for ${nodeName}; node not configured`);
                        continue;
                    }
                    try {
                        await restoreRemoteSystemd(node, sourceDir);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        throw new Error(`Failed to restore services on ${nodeName}: ${message}`);
                    }
                }
            }
        }

        try {
            await execFileAsync('systemctl', ['--user', 'daemon-reload']);
        } catch (error) {
            logger.warn('SystemBackup', 'Failed to reload systemd after restore', error);
        }

        return entry;
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function previewSystemBackup(archivePath: string): Promise<BackupPreviewResult> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-preview-'));
    try {
        await runTar(['-xzf', archivePath, '-C', stagingDir]);
        const configDir = path.join(stagingDir, 'config');
        const backupConfig = await readJsonFile<Awaited<ReturnType<typeof getConfig>>>(path.join(configDir, 'config.json'));
        const nodesFile = await readJsonFile<PodmanConnection[]>(path.join(configDir, 'nodes.json'));
        const checksFile = await readJsonFile<Array<{ id?: string; name?: string; type?: string; target?: string }>>(path.join(configDir, 'checks.json'));

        const registriesItems = Array.isArray(backupConfig?.registries)
            ? backupConfig.registries
            : (backupConfig?.registries?.items ?? []);

        const configPreview: BackupPreviewConfig = {
            nodes: (nodesFile || []).map(node => ({
                name: node.Name,
                uri: node.URI,
                identity: node.Identity,
                default: node.Default
            })),
            checks: (checksFile || []).map(check => ({
                id: check.id || check.name || 'unknown',
                name: check.name || check.id || 'Unnamed check',
                type: check.type,
                target: check.target
            })),
            externalLinks: (backupConfig?.externalLinks || []).map(link => ({
                name: link.name,
                url: link.url
            })),
            registries: (registriesItems || []).map(registry => ({
                name: registry.name,
                url: registry.url,
                branch: registry.branch
            })),
            gateway: backupConfig?.gateway ? {
                type: backupConfig.gateway.type,
                host: backupConfig.gateway.host
            } : undefined,
            notifications: backupConfig?.notifications?.email ? {
                host: backupConfig.notifications.email.host,
                from: backupConfig.notifications.email.from,
                to: backupConfig.notifications.email.to
            } : undefined,
            templateSettings: Object.keys(backupConfig?.templateSettings || {}),
            logLevel: backupConfig?.logLevel,
            update: backupConfig?.autoUpdate ? {
                enabled: backupConfig.autoUpdate.enabled,
                schedule: backupConfig.autoUpdate.schedule,
                channel: backupConfig.autoUpdate.channel
            } : undefined
        };

        const metadata = await readMetadata(stagingDir);
        const nodesDir = path.join(stagingDir, 'nodes');
        const nodeFiles: BackupPreviewNodeFiles[] = [];

        if (await pathExists(nodesDir)) {
            const entries = await fs.readdir(nodesDir, { withFileTypes: true });
            for (const dirent of entries) {
                if (!dirent.isDirectory()) continue;
                const folder = dirent.name;
                const nodeName = metadata?.nodes.find(n => n.folder === folder)?.name ?? decodeNodeFolder(folder);
                const systemdDir = path.join(nodesDir, folder, 'systemd');
                if (!(await pathExists(systemdDir))) continue;
                const files = await listFilesRecursive(systemdDir);
                const mapped = files.map(filePath => {
                    const relativePath = path.relative(systemdDir, filePath).split(path.sep).join('/');
                    return {
                        relativePath,
                        fileName: path.basename(filePath)
                    };
                }).sort((a, b) => a.fileName.localeCompare(b.fileName));
                nodeFiles.push({ nodeName, files: mapped });
            }
        }

        return { config: configPreview, nodeFiles };
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function readSystemBackupFile(archivePath: string, nodeName: string, relativePath: string): Promise<string> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-file-preview-'));
    try {
        await runTar(['-xzf', archivePath, '-C', stagingDir]);
        const metadata = await readMetadata(stagingDir);
        const folder = metadata?.nodes.find(n => n.name === nodeName)?.folder;
        const resolvedFolder = folder || encodeNodeFolder(nodeName);
        const systemdDir = path.join(stagingDir, 'nodes', resolvedFolder, 'systemd');
        if (!(await pathExists(systemdDir))) {
            throw new Error('Systemd folder not found in backup');
        }
        const safeRelative = sanitizeRelativePath(relativePath);
        const resolvedPath = path.resolve(systemdDir, ...safeRelative.split('/'));
        const systemdRoot = path.resolve(systemdDir) + path.sep;
        if (!resolvedPath.startsWith(systemdRoot)) {
            throw new Error('Invalid file path');
        }
        if (!(await pathExists(resolvedPath))) {
            throw new Error('File not found in backup');
        }
        return await fs.readFile(resolvedPath, 'utf8');
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function restoreSystemBackupSelection(archivePath: string, selection: BackupRestoreSelection): Promise<void> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-restore-'));
    try {
        await runTar(['-xzf', archivePath, '-C', stagingDir]);
        const configDir = path.join(stagingDir, 'config');
        const backupConfig = await readJsonFile<Awaited<ReturnType<typeof getConfig>>>(path.join(configDir, 'config.json'));

        const configUpdates: Partial<Awaited<ReturnType<typeof getConfig>>> = {};
        if (selection.config.externalLinks && backupConfig?.externalLinks) {
            configUpdates.externalLinks = backupConfig.externalLinks;
        }
        if (selection.config.registries && backupConfig?.registries) {
            configUpdates.registries = backupConfig.registries;
        }
        if (selection.config.gateway && backupConfig?.gateway) {
            configUpdates.gateway = backupConfig.gateway;
        }
        if (selection.config.notifications && backupConfig?.notifications) {
            configUpdates.notifications = backupConfig.notifications;
        }
        if (selection.config.templateSettings && backupConfig?.templateSettings) {
            configUpdates.templateSettings = backupConfig.templateSettings;
        }
        if (selection.config.logLevel && backupConfig?.logLevel) {
            configUpdates.logLevel = backupConfig.logLevel;
        }
        if (selection.config.update && backupConfig?.autoUpdate) {
            configUpdates.autoUpdate = backupConfig.autoUpdate;
        }

        if (Object.keys(configUpdates).length > 0) {
            await updateConfig(configUpdates);
        }

        if (selection.config.nodes?.length) {
            const backupNodes = await readJsonFile<PodmanConnection[]>(path.join(configDir, 'nodes.json')) || [];
            const existingNodes = await readJsonFile<PodmanConnection[]>(path.join(DATA_DIR, 'nodes.json')) || [];
            const nodeMap = new Map(existingNodes.map(node => [node.Name, node]));
            for (const node of backupNodes) {
                if (selection.config.nodes.includes(node.Name)) {
                    nodeMap.set(node.Name, node);
                }
            }
            await fs.writeFile(path.join(DATA_DIR, 'nodes.json'), JSON.stringify(Array.from(nodeMap.values()), null, 2));
        }

        if (selection.config.checks?.length) {
            const backupChecks = await readJsonFile<Array<{ id?: string; name?: string }>>(path.join(configDir, 'checks.json')) || [];
            const existingChecks = await readJsonFile<Array<{ id?: string; name?: string }>>(path.join(DATA_DIR, 'checks.json')) || [];
            const getKey = (check: { id?: string; name?: string }) => check.id || check.name || '';
            const checkMap = new Map(existingChecks.map(check => [getKey(check), check]));
            for (const check of backupChecks) {
                const key = getKey(check);
                if (key && selection.config.checks.includes(key)) {
                    checkMap.set(key, check);
                }
            }
            await fs.writeFile(path.join(DATA_DIR, 'checks.json'), JSON.stringify(Array.from(checkMap.values()), null, 2));
        }

        if (selection.nodeFiles.length > 0) {
            const metadata = await readMetadata(stagingDir);
            const nodesDir = path.join(stagingDir, 'nodes');
            const nodesFromDisk = await listNodes();
            const nodesMap = new Map(nodesFromDisk.map(node => [node.Name, node]));
            const systemdTargets = new Map<string, string[]>();

            for (const group of selection.nodeFiles) {
                const folder = metadata?.nodes.find(n => n.name === group.sourceNode)?.folder;
                const resolvedFolder = folder || encodeNodeFolder(group.sourceNode);
                const sourceDir = path.join(nodesDir, resolvedFolder, 'systemd');
                if (!(await pathExists(sourceDir))) continue;

                const targetNode = group.targetNode;
                if (!targetNode) continue;

                const targetEntries = systemdTargets.get(targetNode) || [];
                systemdTargets.set(targetNode, targetEntries);

                for (const relativePath of group.files) {
                    const safePath = relativePath.replace(/\\/g, '/');
                    if (safePath.includes('..')) continue;
                    const sourceFile = path.join(sourceDir, safePath);
                    if (!(await pathExists(sourceFile))) continue;
                    if (targetNode === 'Local') {
                        const destination = path.join(getLocalSystemdDir(), safePath);
                        await fs.mkdir(path.dirname(destination), { recursive: true });
                        await fs.copyFile(sourceFile, destination);
                    } else {
                        const node = nodesMap.get(targetNode);
                        if (!node) {
                            throw new Error(`Target node ${targetNode} not configured`);
                        }
                        const conn = await SSHConnectionPool.getInstance().getConnection(node.Name);
                        const remoteSystemd = await resolveRemoteSystemdDir(conn);
                        const remotePath = path.posix.join(remoteSystemd, safePath.split(path.sep).join('/'));
                        const remoteDir = path.posix.dirname(remotePath);
                        await execRemoteCommand(conn, `mkdir -p "${remoteDir}"`);
                        const tempLocal = path.join(os.tmpdir(), `servicebay-restore-${Date.now()}-${path.basename(remotePath)}`);
                        await fs.copyFile(sourceFile, tempLocal);
                        await uploadRemoteFile(conn, tempLocal, remotePath);
                        await fs.rm(tempLocal, { force: true });
                    }
                    targetEntries.push(safePath);
                }
            }

            for (const [targetNode] of systemdTargets) {
                if (targetNode === 'Local') {
                    try {
                        await execFileAsync('systemctl', ['--user', 'daemon-reload']);
                    } catch (error) {
                        logger.warn('SystemBackup', 'Failed to reload systemd after restore', error);
                    }
                } else {
                    const node = nodesMap.get(targetNode);
                    if (!node) continue;
                    const conn = await SSHConnectionPool.getInstance().getConnection(node.Name);
                    const reload = await execRemoteCommand(conn, 'systemctl --user daemon-reload');
                    if (reload.code !== 0) {
                        logger.warn('SystemBackup', `Remote daemon reload failed on ${targetNode}: ${reload.stderr || reload.stdout}`);
                    }
                }
            }
        }
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}