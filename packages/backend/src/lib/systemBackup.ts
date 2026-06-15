import fs from 'fs/promises';
import path from 'path';
import os from 'os';
// `node:` prefix so the import always resolves to the real built-in.
// Without it, a stray browser-polyfill stack leaking into Vite's SSR
// module graph (e.g. via @storybook/nextjs's webpack resolution) can
// shadow `child_process` with `node-libs-browser`'s no-op stub —
// execFile then returns undefined stdout, every tar listing comes
// back empty, and the safeTarExtract security gates collapse without
// the test suite noticing. The prefix is the marker Node's resolver
// treats as "built-in, do not redirect."
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Client, SFTPWrapper } from 'ssh2';
import { DATA_DIR, SERVICEBAY_BACKUP_DIR, getLocalSystemdDir } from './dirs';
import { logger } from './logger';
import { listNodes, PodmanConnection } from './nodes';
import { SSHConnectionPool } from './ssh/pool';
import { getConfig, updateConfig } from './config';
import { shellQuote } from './util/shellQuote';
import type { Executor } from './executor';

const execFileAsync = promisify(execFile);
const BACKUP_PREFIX = 'servicebay-full';
const CONFIG_FILES = ['config.json', 'nodes.json', 'checks.json'];
const REMOTE_SYSTEMD_DIR = '$HOME/.config/containers/systemd';
const METADATA_FILE = 'metadata.json';
const METADATA_VERSION = 2;

/**
 * How a system backup came to exist:
 *   - `auto`   — a pre-mutation snapshot taken automatically by the MCP
 *                safety layer before a destructive tool runs.
 *   - `manual` — a user-triggered snapshot (Settings → Backups POST route).
 *
 * Persisted purely in the filename suffix (`-auto.tar.gz` / `-manual.tar.gz`)
 * so listing stays a pure readdir with no sidecar/DB.
 *
 * `legacy` is a read-only classification for the ~8k pre-existing snapshots
 * named `servicebay-full-<ISO>.tar.gz` with NO suffix — they predate the
 * suffix scheme. They are treated as MANUAL for safety (never auto-pruned),
 * but surfaced with their own kind so the UI/operator can tell them apart.
 */
export type SystemBackupKind = 'auto' | 'manual' | 'legacy';

/** How many `auto` (pre-mutation) snapshots to keep. Older auto ones are
 *  pruned after each new auto snapshot. Manual and legacy are never pruned. */
export const AUTO_BACKUP_RETENTION = 20;

export interface SystemBackupEntry {
    fileName: string;
    path: string;
    createdAt: string;
    size: number;
    /** Origin of the snapshot — derived from the filename suffix. */
    kind: SystemBackupKind;
}

/**
 * Classify a backup filename by its suffix. Newly-written snapshots carry an
 * explicit `-auto`/`-manual` suffix; anything without one is a pre-suffix
 * legacy file and is treated as NON-prunable.
 */
function classifyBackupKind(fileName: string): SystemBackupKind {
    const base = fileName.slice(0, -'.tar.gz'.length);
    if (base.endsWith('-auto')) return 'auto';
    if (base.endsWith('-manual')) return 'manual';
    return 'legacy';
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

export interface BackupPreviewServiceData {
    name: string;
    files: string[];
    sourcePath?: string;
    nodeName?: string;
}

export interface BackupPreviewResult {
    config: BackupPreviewConfig;
    nodeFiles: BackupPreviewNodeFiles[];
    serviceData?: BackupPreviewServiceData[];
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
    serviceData?: string[] | ServiceDataSelection[];
}

export interface ServiceDataSelection {
    name: string;
    files?: string[]; // if omitted, restore all files
}

interface BackupNodeDescriptor {
    name: string;
    folder: string;
    scope: 'local' | 'remote';
}

interface ServiceDataEntry {
    /** The on-disk subdir under `service-config/` in the archive — the manifest
     *  `service` name (e.g. `home-assistant`, `nginx`). Kept named `label` for
     *  metadata back-compat with v2 backups. */
    label: string;
    /** Resolved service data dir the config was read from / restores back to. */
    sourcePath: string;
    nodeName: string;
    /** Manifest `service` name — resolves the restore target dir per node via
     *  the per-service producer. Absent on legacy (proxy hostPath) backups. */
    service?: string;
}

interface BackupMetadata {
    version: number;
    createdAt: string;
    nodes: BackupNodeDescriptor[];
    configFiles: string[];
    serviceData?: string[] | ServiceDataEntry[];
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

/**
 * Refuse tar entries that would escape the extraction directory
 * (#580, #590). Parses `tar -tvzf` output (verbose, includes the
 * Unix-style type+permissions column) and rejects:
 *   - absolute paths       (`/etc/shadow`)
 *   - traversal segments   (`../something`, `foo/../../bar`)
 *   - symlinks / hardlinks (#590 Option B — backup payloads are
 *     control-plane Quadlets + config + sealed JSON; symlinks have
 *     no legitimate purpose there, and refusing them at the pre-check
 *     means the local AND remote restore paths get the same
 *     protection without needing to ship a TypeScript-side walker
 *     across SSH)
 *
 * `assertNoSymlinkEscape` (local path only) stays as defense in depth.
 */
/**
 * Whether a symlink's target points outside the extraction root, given the
 * link's own path within the archive. Absolute targets always escape; relative
 * targets are resolved against the link's directory and escape only if they
 * climb above the root. Internal links (Let's Encrypt's
 * `live/x/cert.pem -> ../../archive/x/cert1.pem`) stay within root → allowed.
 */
function linkTargetEscapes(linkName: string, target: string): boolean {
    if (!target) return false;
    if (path.posix.isAbsolute(target)) return true;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkName), target));
    return resolved === '..' || resolved.startsWith('../');
}

export async function assertSafeArchiveEntries(archivePath: string, gzip = true): Promise<void> {
    let stdout: string;
    try {
        const result = await execFileAsync('tar', [gzip ? '-tvzf' : '-tvf', archivePath]);
        // Default to empty string for the mocked-test path where
        // execFileAsync is stubbed to return no stdout. Production
        // tar always emits the listing on stdout.
        stdout = result.stdout ?? '';
    } catch (error) {
        throw new Error(`Failed to inspect ${path.basename(archivePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
        // GNU tar verbose format: `<type><perms> owner/group size date time name [-> linkname]`.
        // First char is the type: -, d, l (symlink), h (hardlink), c, b, p, s.
        const typeChar = line[0];
        // Extract the entry name — the name field starts after the
        // date/time. Splitting on whitespace and skipping the leading
        // fixed columns is robust enough for both GNU + BSD tar.
        const tokens = line.split(/\s+/);
        // Format columns: 0=type+perms, 1=owner/group, 2=size, 3=date,
        // 4=time, 5+=name (possibly containing spaces + `-> linkname`).
        const nameField = tokens.slice(5).join(' ');
        if (!nameField) continue;
        if (typeChar === 'h') {
            // Hardlinks would create extra references to already-extracted
            // files; no legitimate purpose in a config payload.
            throw new Error(
                `Refused archive ${path.basename(archivePath)}: contains hardlink "${nameField}".`,
            );
        }
        // The bare entry name is everything before ` -> ` (for symlinks).
        const entry = nameField.split(' -> ')[0];
        if (typeChar === 'l') {
            // Allow symlinks whose target resolves WITHIN the extraction root
            // — e.g. Let's Encrypt's `live/x/cert.pem -> ../../archive/x/cert.pem`
            // that NPM ships in its config (#1381). Refuse only escaping links;
            // assertNoSymlinkEscape re-validates resolved targets post-extract.
            const target = nameField.slice(nameField.indexOf(' -> ') + 4);
            if (linkTargetEscapes(entry, target)) {
                throw new Error(
                    `Refused archive ${path.basename(archivePath)}: symlink "${entry}" -> "${target}" ` +
                    `points outside the extraction directory.`,
                );
            }
        }
        if (entry.startsWith('/')) {
            throw new Error(`Refused archive ${path.basename(archivePath)}: contains absolute path "${entry}"`);
        }
        const normalized = path.posix.normalize(entry);
        if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
            throw new Error(`Refused archive ${path.basename(archivePath)}: contains traversal segment "${entry}"`);
        }
    }
}

/**
 * After extraction, walk `dir` and assert no symlink escapes via its
 * resolved real path. Tar's `--no-absolute-names` strips leading `/`
 * during extraction but does NOT block symlinks that point outside —
 * a crafted archive can ship `link → /etc/passwd` and any later read
 * through the link would escape. Catch them post-extraction so we
 * fail loudly + the operator gets a clear refusal instead of a silent
 * file overwrite or read.
 */
async function assertNoSymlinkEscape(dir: string): Promise<void> {
    const realRoot = await fs.realpath(dir);
    async function walk(curr: string): Promise<void> {
        const entries = await fs.readdir(curr, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(curr, entry.name);
            if (entry.isSymbolicLink()) {
                let target: string;
                try {
                    target = await fs.realpath(full);
                } catch {
                    // Broken symlinks are harmless on their own (read fails),
                    // but the *target* string still encodes intent — if it's
                    // absolute or traverses, refuse so the operator knows.
                    const raw = await fs.readlink(full);
                    if (path.isAbsolute(raw) || raw.startsWith('..') || raw.includes('/../')) {
                        throw new Error(`Refused archive: symlink "${path.relative(dir, full)}" → "${raw}" points outside the extraction directory`);
                    }
                    continue;
                }
                const realTarget = await fs.realpath(target).catch(() => target);
                if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
                    throw new Error(`Refused archive: symlink "${path.relative(dir, full)}" → "${realTarget}" escapes the extraction directory`);
                }
            } else if (entry.isDirectory()) {
                await walk(full);
            }
        }
    }
    await walk(dir);
}

/**
 * Safe extraction wrapper used by every restore path (#580).
 *
 *   1. Pre-pass: refuse any archive entry that's absolute or contains
 *      `../` traversal.
 *   2. Extract with hardening flags:
 *        --no-same-owner       — don't try to chown to numeric IDs that
 *                                may have unintended meaning on this host
 *        --no-overwrite-dir    — refuse to replace a directory's
 *                                permissions/metadata with an archive entry
 *        --no-absolute-names   — strip leading `/` (defense in depth — the
 *                                pre-pass would have already refused)
 *        --no-same-permissions — don't preserve setuid/setgid from the
 *                                archive
 *   3. Post-pass: walk the extracted tree and refuse any symlink whose
 *      resolved target escapes `destination`. On refusal, the partial
 *      extraction is cleaned up.
 */
export async function safeTarExtract(
    archivePath: string,
    destination: string,
    opts: { gzip?: boolean } = {},
): Promise<void> {
    const gzip = opts.gzip ?? true;
    await assertSafeArchiveEntries(archivePath, gzip);
    await fs.mkdir(destination, { recursive: true });
    // Note: GNU tar's default behaviour already strips leading `/` —
    // an explicit `--no-absolute-names` flag doesn't exist (the opt-in
    // counterpart is `-P, --absolute-names`). Same logic for `..`
    // segments — tar's default refuses them. We rely on the
    // `assertSafeArchiveEntries` pre-pass as the primary defence and
    // the flags below as belt-and-suspenders.
    await runTar([
        gzip ? '-xzf' : '-xf', archivePath,
        '-C', destination,
        '--no-same-owner',
        '--no-overwrite-dir',
        '--no-same-permissions',
    ]);
    try {
        await assertNoSymlinkEscape(destination);
    } catch (e) {
        // Refused after extraction — clean up so we don't leave a
        // half-extracted tree the next restore can stumble on.
        await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
        throw e;
    }
}

/**
 * Extract a per-service config tar into `destDir` on a target node's HOST
 * filesystem via the node agent (#1597/#1600). The services' data dirs
 * (`/mnt/data/stacks/<svc>`) are NOT bind-mounted into the servicebay
 * container, so the box restore must go through the agent — mirroring the
 * unified restore engine's `agentRestoreBackend`. The traversal/link pre-pass
 * runs in-container on the tar bytes (the primary defence), then the tar is
 * pushed host-side (base64 over the agent's utf-8-only write) and extracted
 * with the same hardening flags `safeTarExtract` uses, followed by a host-side
 * symlink-escape walk.
 */
export async function extractServiceConfigToNode(executor: Executor, tar: Buffer, destDir: string): Promise<void> {
    // In-container traversal/link refusal on the raw tar bytes before anything
    // touches the host.
    const tmp = path.join(os.tmpdir(), `sb-svcconfig-${Date.now()}-${process.pid}.tar`);
    try {
        await fs.writeFile(tmp, tar);
        await assertSafeArchiveEntries(tmp, false);
    } finally {
        await fs.rm(tmp, { force: true });
    }
    const { stdout } = await executor.execArgv(['mktemp', '-t', 'sb-svcconfig-XXXXXX']);
    const hostTar = stdout.trim();
    const hostTarB64 = `${hostTar}.b64`;
    try {
        await executor.writeFile(hostTarB64, tar.toString('base64'));
        await executor.execArgv(['sh', '-c', 'base64 -d "$1" > "$2"', 'sh', hostTarB64, hostTar], { timeoutMs: 120_000 });
        await executor.execArgv(['mkdir', '-p', destDir]);
        await executor.execArgv(
            ['tar', '-xf', hostTar, '-C', destDir, '--no-same-owner', '--no-overwrite-dir', '--no-same-permissions'],
            { timeoutMs: 120_000 },
        );
        // Host-side symlink-escape walk (defense in depth): refuse any symlink
        // that resolves outside destDir, cleaning up on refusal.
        const realRoot = (await executor.execArgv(['readlink', '-f', destDir])).stdout.trim();
        const links = (await executor.execArgv(['find', destDir, '-type', 'l'])).stdout
            .split('\n').map(l => l.trim()).filter(Boolean);
        for (const link of links) {
            const resolved = (await executor.execArgv(['readlink', '-f', link]).catch(() => ({ stdout: '' }))).stdout.trim();
            if (!resolved || (resolved !== realRoot && !resolved.startsWith(realRoot + '/'))) {
                await executor.execArgv(['rm', '-rf', destDir]).catch(() => {});
                throw new Error(`Refused archive: symlink "${link}" → "${resolved}" escapes the extraction directory`);
            }
        }
    } finally {
        await executor.execArgv(['rm', '-f', hostTarB64, hostTar]).catch(() => {});
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

/**
 * Stage every installed service's CONFIG (not bulk DATA) into the archive's
 * `service-config/<svc>/` tree, reusing the per-service producer so the bytes
 * are identical to the NAS atom (epic #1607/#1608 — the same include/exclude/
 * glob/strip/transform/collector spec, run host-side via the node agent).
 *
 * Replaces the old nginx-only `isProxy` hostPath loop: nginx is now just another
 * manifest atom. Returns true if at least one service contributed config.
 *
 * Services run on the box ServiceBay itself manages (the Local node), and
 * `installedTemplates` is global config; we resolve each service's data dir and
 * read it through the host agent (#1597), the same path install/restore/deploy
 * use. Per-service failures are logged and skipped — one bad service doesn't
 * abort the snapshot.
 */
export async function stageServiceConfig(
    stagingDir: string,
    metadata: BackupMetadata,
    logs: BackupLogEntry[],
    progress: ProgressCallback | undefined,
): Promise<boolean> {
    const serviceConfigRoot = path.join(stagingDir, 'service-config');
    metadata.serviceData = [];

    const { SERVICE_BACKUP_MANIFESTS, getBackupGate } = await import('./externalBackup/serviceManifest');
    const { buildServiceBackupTar, agentFileBackend, resolveServiceDataDir, runBackupCollector } = await import('./externalBackup/producer');
    const { getExecutor } = await import('./executor');

    const installed = new Set(Object.keys((await getConfig()).installedTemplates ?? {}));
    const nodeName = 'Local';
    const backend = agentFileBackend(getExecutor(nodeName));
    let stagedAny = false;

    for (const manifest of SERVICE_BACKUP_MANIFESTS) {
        // Sibling-store entries (#1594) gate on their parent template, not their
        // own synthetic service name.
        if (!installed.has(getBackupGate(manifest))) continue;
        const svc = manifest.service;
        try {
            const serviceDataDir = await resolveServiceDataDir(svc);
            // The producer runs any in-container collector (NPM's consistent
            // sqlite snapshot) itself when given an agent backend + node — but
            // buildServiceBackupTar takes a resolved manifest, so we mirror
            // backupServiceToNas's collector step.
            const effective = manifest.collector
                ? await runBackupCollector(manifest, nodeName)
                : manifest;
            const tar = await buildServiceBackupTar(serviceDataDir, effective, backend);

            const destDir = path.join(serviceConfigRoot, svc);
            await fs.mkdir(destDir, { recursive: true });
            const tmpTar = path.join(serviceConfigRoot, `${svc}.tar`);
            await fs.writeFile(tmpTar, tar);
            // The producer builds a SAFE-by-construction plain tar from a staging
            // dir it controls; safeTarExtract (gzip:false) still applies the
            // standard restore-side hardening as belt-and-suspenders.
            await safeTarExtract(tmpTar, destDir, { gzip: false });
            await fs.rm(tmpTar, { force: true });

            (metadata.serviceData as ServiceDataEntry[]).push({
                label: svc,
                service: svc,
                sourcePath: serviceDataDir,
                nodeName,
            });
            stagedAny = true;
            pushLog(logs, progress, { scope: 'local', status: 'success', node: nodeName, message: `Captured config for ${svc}` });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // "No config files to back up" just means the service has no
            // on-disk config yet — a skip, not an error.
            const status: BackupLogStatus = /No config files to back up/.test(message) ? 'skip' : 'error';
            pushLog(logs, progress, { scope: 'local', status, node: nodeName, message: `${svc}: ${message}` });
        }
    }

    return stagedAny;
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
        // REMOTE_SYSTEMD_DIR contains the literal "$HOME" sentinel that
        // the remote shell must expand — intentionally NOT shellQuote'd.
        // See note in restoreRemoteSystemd; same constraint applies.
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
    await execRemoteCommand(conn, `rm -f ${shellQuote(remoteTemp)}`);
    await safeTarExtract(localTemp, destination);
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

    // SSH-side equivalent of safeTarExtract (#580, #590). Refuse
    // archive entries that are absolute / contain traversal / are
    // symlinks-or-hardlinks *before* extracting, then extract with
    // hardening flags. `tar -tvzf` emits the type indicator in the
    // first column (l = symlink, h = hardlink) so the awk guard
    // mirrors the local `assertSafeArchiveEntries` pre-check.
    const extractScript = [
        'set -e',
        // REMOTE_SYSTEMD_DIR is a constant containing the literal "$HOME"
        // sentinel — the remote shell must expand it, so we intentionally
        // do NOT shellQuote it. If this ever becomes config-driven, switch
        // to shellQuote + pre-resolved absolute path.
        `target=${REMOTE_SYSTEMD_DIR}`,
        `tmp=${shellQuote(remoteTemp)}`,
        // Pre-pass: refuse symlinks/hardlinks (#590) or abs/traversal entries (#580).
        // awk exits non-zero on the first offender so set -e aborts.
        `tar -tvzf "$tmp" | awk '/^[lh]/ { print "Refused archive: contains link entry: " $NF > "/dev/stderr"; exit 2 } { for (i=6; i<=NF; i++) name = (i==6 ? $i : name " " $i); if (name ~ /^\\// || name ~ /(^|\\/)\\.\\.($|\\/)/) { print "Refused archive: contains abs/traversal entry: " name > "/dev/stderr"; exit 2 } }'`,
        'mkdir -p "$target"',
        `tar -xzf "$tmp" -C "$target" --no-same-owner --no-overwrite-dir --no-same-permissions`,
        `rm -f "$tmp"`,
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
            size: stats.size,
            kind: classifyBackupKind(fileName)
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
        size: stats.size,
        kind: classifyBackupKind(safeName)
    };
}

export async function deleteSystemBackup(fileName: string): Promise<void> {
    const entry = await getBackupFileMeta(fileName);
    await fs.unlink(entry.path);
}

/**
 * Hash the ServiceBay config files (config.json/nodes.json/checks.json) as
 * they currently sit in DATA_DIR. Used to dedup auto snapshots: most
 * `exec_command` calls don't change config, so a pre-mutation snapshot whose
 * config matches the latest auto snapshot is skippable (#1868). Missing files
 * contribute nothing — two configs with the same present files + bytes hash
 * identically.
 */
async function hashCurrentConfig(): Promise<string> {
    const hash = createHash('sha256');
    for (const fileName of CONFIG_FILES) {
        const filePath = path.join(DATA_DIR, fileName);
        try {
            const buf = await fs.readFile(filePath);
            hash.update(fileName);
            hash.update('\0');
            hash.update(buf);
            hash.update('\0');
        } catch {
            // Missing file — skip; its absence is part of the fingerprint.
        }
    }
    return hash.digest('hex');
}

/**
 * Hash the config files stored inside an already-written backup archive
 * (its `config/` dir), using the same scheme as `hashCurrentConfig`, so the
 * two are directly comparable. Returns null if the archive can't be read.
 */
async function hashSnapshotConfig(archivePath: string): Promise<string | null> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-dedup-'));
    try {
        await safeTarExtract(archivePath, stagingDir);
        const configDir = path.join(stagingDir, 'config');
        const hash = createHash('sha256');
        for (const fileName of CONFIG_FILES) {
            const filePath = path.join(configDir, fileName);
            try {
                const buf = await fs.readFile(filePath);
                hash.update(fileName);
                hash.update('\0');
                hash.update(buf);
                hash.update('\0');
            } catch {
                // Missing file — same treatment as hashCurrentConfig.
            }
        }
        return hash.digest('hex');
    } catch {
        return null;
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

/**
 * Dedup guard for the pre-mutation (auto) path (#1868): true when the current
 * ServiceBay config is byte-identical to the most recent AUTO snapshot, so a
 * fresh auto snapshot would be a redundant copy. Mirrors history.ts's
 * latest-snapshot content compare. Manual/legacy snapshots are ignored here —
 * dedup only ever compares against the latest auto snapshot.
 */
export async function autoSnapshotWouldDuplicate(): Promise<boolean> {
    const backups = await listSystemBackups();
    const latestAuto = backups.find(b => b.kind === 'auto'); // list is newest-first
    if (!latestAuto) return false;
    const [current, previous] = await Promise.all([
        hashCurrentConfig(),
        hashSnapshotConfig(latestAuto.path),
    ]);
    return previous !== null && current === previous;
}

/**
 * Prune AUTO snapshots beyond AUTO_BACKUP_RETENTION, newest-first. NEVER
 * touches manual or legacy (unsuffixed) snapshots — a buried legacy file
 * could be a real manual snapshot, and the ~8k legacy pile is cleaned
 * out-of-band with operator confirmation. Best-effort: unlink failures log
 * and don't abort the just-written backup.
 */
async function pruneAutoSnapshots(): Promise<void> {
    const backups = await listSystemBackups();
    const autos = backups.filter(b => b.kind === 'auto'); // already newest-first
    const stale = autos.slice(AUTO_BACKUP_RETENTION);
    for (const entry of stale) {
        try {
            await fs.unlink(entry.path);
        } catch (e) {
            logger.warn('SystemBackup', `Failed to prune auto snapshot ${entry.fileName}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export async function createSystemBackup(kind: 'auto' | 'manual' = 'manual', progress?: ProgressCallback): Promise<SystemBackupResult> {
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

        // Stage per-service CONFIG (not bulk data) from every installed service
        // that has a backup manifest — HA `.storage`/automations/zwave keys,
        // adguard, authelia, syncthing, hermes, and nginx (just another atom).
        // This reuses the per-service producer (`stageServiceBackup` via the
        // host-agent backend, #1597) so the Snapshot's service-config section is
        // byte-identical to the NAS atom (epic invariant #1607/#1608). It
        // retires the old nginx-only `isProxy` hostPath loop. Bulk DATA-class
        // paths (Immich library, recorder DB, vectordb, zwave mesh db) stay
        // excluded — those are Backup Sync's job.
        if (await stageServiceConfig(stagingDir, metadata, logs, progress)) {
            stagedSomething = true;
        }

        if (!stagedSomething) {
            throw new Error('Nothing to backup');
        }

        await fs.writeFile(path.join(stagingDir, METADATA_FILE), JSON.stringify(metadata, null, 2));

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // Persist the kind in the filename suffix so listing stays a pure
        // readdir (no sidecar/DB) — see classifyBackupKind / SystemBackupKind.
        const fileName = `${BACKUP_PREFIX}-${timestamp}-${kind}.tar.gz`;
        const archivePath = path.join(SERVICEBAY_BACKUP_DIR, fileName);
        pushLog(logs, progress, { scope: 'archive', status: 'info', message: 'Creating compressed archive' });
        await runTar(['-czf', archivePath, '-C', stagingDir, '.']);
        pushLog(logs, progress, { scope: 'archive', status: 'success', message: 'Backup archive ready', target: archivePath });

        const entry = await getBackupFileMeta(fileName);

        // Retention: after writing a new AUTO snapshot, prune older auto ones
        // beyond AUTO_BACKUP_RETENTION. Never prunes manual/legacy (#1868).
        if (kind === 'auto') {
            await pruneAutoSnapshots();
        }

        return { entry, log: logs };
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function restoreSystemBackup(fileName: string): Promise<SystemBackupEntry> {
    const entry = await getBackupFileMeta(fileName);
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-restore-'));
    try {
        await safeTarExtract(entry.path, stagingDir);
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
        await safeTarExtract(archivePath, stagingDir);
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

        // Preview per-service config (HA `.storage`/automations/zwave keys,
        // adguard, authelia, syncthing, hermes, nginx). Falls back to the legacy
        // `service-data/` dir name so a v2 backup still previews.
        let serviceConfigDir = path.join(stagingDir, 'service-config');
        if (!(await pathExists(serviceConfigDir))) {
            serviceConfigDir = path.join(stagingDir, 'service-data');
        }
        const serviceData: BackupPreviewServiceData[] = [];
        if (await pathExists(serviceConfigDir)) {
            const backupMeta = await readMetadata(stagingDir);
            const sdEntries = backupMeta?.serviceData;
            const sdMeta = (sdEntries && sdEntries.length > 0 && typeof sdEntries[0] === 'object')
                ? sdEntries as ServiceDataEntry[]
                : undefined;

            const dataDirs = await fs.readdir(serviceConfigDir, { withFileTypes: true });
            for (const dirent of dataDirs) {
                if (!dirent.isDirectory()) continue;
                const dirPath = path.join(serviceConfigDir, dirent.name);
                const files = await listFilesRecursive(dirPath);
                const metaEntry = sdMeta?.find(e => e.label === dirent.name);
                serviceData.push({
                    name: dirent.name,
                    files: files.map(f => path.relative(dirPath, f).split(path.sep).join('/')),
                    sourcePath: metaEntry?.sourcePath,
                    nodeName: metaEntry?.nodeName
                });
            }
        }

        return { config: configPreview, nodeFiles, serviceData };
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}

export async function readSystemBackupFile(archivePath: string, nodeName: string, relativePath: string): Promise<string> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-file-preview-'));
    try {
        await safeTarExtract(archivePath, stagingDir);
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
        await safeTarExtract(archivePath, stagingDir);
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
                        await execRemoteCommand(conn, `mkdir -p ${shellQuote(remoteDir)}`);
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

        // Restore per-service config to each service's resolved data dir. The
        // staged layout is `service-config/<svc>/` (legacy backups: `service-data/`),
        // and the per-service producer's manifest defines the target dir, so the
        // restore writes config back where the live service reads it (#1597) via
        // the host agent — the same hardened path the unified restore engine uses.
        if (selection.serviceData?.length) {
            const backupMetadata = await readMetadata(stagingDir);
            let serviceConfigDir = path.join(stagingDir, 'service-config');
            if (!(await pathExists(serviceConfigDir))) {
                serviceConfigDir = path.join(stagingDir, 'service-data');
            }
            const { resolveServiceDataDir } = await import('./externalBackup/producer');
            const { getExecutor } = await import('./executor');

            // Normalize selection: support both string[] (all files) and ServiceDataSelection[]
            const normalizedSelections: ServiceDataSelection[] = selection.serviceData.map(item =>
                typeof item === 'string' ? { name: item } : item
            );

            for (const sdSelection of normalizedSelections) {
                const dirName = sdSelection.name;
                const localDir = path.join(serviceConfigDir, dirName);
                if (!(await pathExists(localDir))) continue;

                // Resolve the target data dir + node from metadata (manifest-driven
                // v2+), falling back to re-resolving the service's data dir.
                let targetPath: string | undefined;
                let targetNodeName = 'Local';
                let serviceName = dirName;

                const sdEntries = backupMetadata?.serviceData;
                if (sdEntries && sdEntries.length > 0 && typeof sdEntries[0] === 'object') {
                    const entry = (sdEntries as ServiceDataEntry[]).find(e => e.label === dirName);
                    if (entry) {
                        targetPath = entry.sourcePath;
                        targetNodeName = entry.nodeName || 'Local';
                        serviceName = entry.service || dirName;
                    }
                }
                if (!targetPath) {
                    // No metadata (legacy/missing) — re-resolve from the manifest.
                    try {
                        targetPath = await resolveServiceDataDir(serviceName);
                    } catch {
                        logger.warn('SystemBackup', `No target path for service-config "${dirName}", skipping`);
                        continue;
                    }
                }

                // If specific files requested, create a filtered staging directory.
                let archiveSourceDir = localDir;
                let filteredDir: string | undefined;
                if (sdSelection.files && sdSelection.files.length > 0) {
                    filteredDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-sdfilter-'));
                    for (const relFile of sdSelection.files) {
                        const safePath = sanitizeRelativePath(relFile);
                        const srcFile = path.join(localDir, safePath);
                        const destFile = path.join(filteredDir, safePath);
                        if (await pathExists(srcFile)) {
                            await fs.mkdir(path.dirname(destFile), { recursive: true });
                            await fs.copyFile(srcFile, destFile);
                        }
                    }
                    archiveSourceDir = filteredDir;
                }

                try {
                    // Tar the staged config (plain tar — the producer's atom format)
                    // and extract it host-side via the node agent with the same
                    // hardened guards (#580/#590) the restore engine applies.
                    const tmpArchive = path.join(os.tmpdir(), `servicebay-svcconfig-${Date.now()}.tar`);
                    try {
                        await runTar(['-cf', tmpArchive, '-C', archiveSourceDir, '.']);
                        const tarBytes = await fs.readFile(tmpArchive);
                        await extractServiceConfigToNode(getExecutor(targetNodeName), tarBytes, targetPath);
                    } finally {
                        await fs.rm(tmpArchive, { force: true });
                    }
                    const fileDesc = sdSelection.files ? `${sdSelection.files.length} files from ${dirName}` : dirName;
                    logger.info('SystemBackup', `Restored ${fileDesc} to ${targetNodeName}:${targetPath}`);
                } finally {
                    if (filteredDir) await fs.rm(filteredDir, { recursive: true, force: true });
                }
            }
        }
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
    }
}