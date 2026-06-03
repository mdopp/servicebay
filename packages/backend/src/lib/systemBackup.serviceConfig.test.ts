import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Executor } from './executor';

const execFileAsync = promisify(execFile);

const { mockManifest, mockProducer, mockGetExecutor, mockCfg } = vi.hoisted(() => ({
    mockManifest: { SERVICE_BACKUP_MANIFESTS: [] as unknown[], getBackupGate: vi.fn() },
    mockProducer: {
        buildServiceBackupTar: vi.fn(),
        agentFileBackend: vi.fn(() => ({})),
        resolveServiceDataDir: vi.fn(),
        runBackupCollector: vi.fn(),
    },
    mockGetExecutor: vi.fn(),
    mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn() },
}));

vi.mock('./externalBackup/serviceManifest', () => mockManifest);
vi.mock('./externalBackup/producer', () => mockProducer);
vi.mock('./executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));
vi.mock('./config', () => mockCfg);

import { stageServiceConfig, extractServiceConfigToNode } from './systemBackup';

/** Build a plain tar (manifest atom format) with files at the given relative paths. */
async function buildTar(files: Record<string, string>): Promise<Buffer> {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-cfg-stage-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(stage, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
    }
    const tarPath = path.join(stage, 'out.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', stage, '.']);
    const buf = await fs.readFile(tarPath);
    await fs.rm(stage, { recursive: true, force: true });
    return buf;
}

let tmpRoot: string;

beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sysbackup-svccfg-'));
    mockManifest.SERVICE_BACKUP_MANIFESTS = [];
    mockManifest.getBackupGate.mockImplementation((m: { service: string }) => m.service);
    mockProducer.agentFileBackend.mockReturnValue({});
    mockGetExecutor.mockReturnValue({} as Executor);
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: {} });
});

afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('stageServiceConfig', () => {
    it('stages config for each installed manifest into service-config/<svc>/ and records metadata', async () => {
        mockCfg.getConfig.mockResolvedValue({ installedTemplates: { 'home-assistant': {}, nginx: {} } });
        mockManifest.SERVICE_BACKUP_MANIFESTS = [
            { service: 'home-assistant' },
            { service: 'nginx' },
        ];
        mockProducer.resolveServiceDataDir.mockImplementation(async (svc: string) => `/mnt/data/stacks/${svc}`);
        mockProducer.buildServiceBackupTar.mockImplementation(async (_dir: string, m: { service: string }) =>
            buildTar({ [`${m.service}.conf`]: `cfg for ${m.service}` }),
        );

        const metadata = { version: 3, createdAt: '', nodes: [], configFiles: [] };
        const logs: unknown[] = [];
        const staged = await stageServiceConfig(tmpRoot, metadata as never, logs as never, undefined);

        expect(staged).toBe(true);
        // Files landed under service-config/<svc>/
        const haFile = path.join(tmpRoot, 'service-config', 'home-assistant', 'home-assistant.conf');
        const nginxFile = path.join(tmpRoot, 'service-config', 'nginx', 'nginx.conf');
        await expect(fs.readFile(haFile, 'utf8')).resolves.toBe('cfg for home-assistant');
        await expect(fs.readFile(nginxFile, 'utf8')).resolves.toBe('cfg for nginx');
        // The per-service tmp tar is cleaned up.
        await expect(fs.access(path.join(tmpRoot, 'service-config', 'home-assistant.tar'))).rejects.toThrow();
        // Metadata records {label, service, sourcePath, nodeName}.
        expect(metadata).toHaveProperty('serviceData');
        const sd = (metadata as { serviceData: Array<{ label: string; service: string; sourcePath: string; nodeName: string }> }).serviceData;
        expect(sd).toEqual([
            { label: 'home-assistant', service: 'home-assistant', sourcePath: '/mnt/data/stacks/home-assistant', nodeName: 'Local' },
            { label: 'nginx', service: 'nginx', sourcePath: '/mnt/data/stacks/nginx', nodeName: 'Local' },
        ]);
    });

    it('skips manifests whose backup-gate template is not installed', async () => {
        mockCfg.getConfig.mockResolvedValue({ installedTemplates: { nginx: {} } });
        mockManifest.SERVICE_BACKUP_MANIFESTS = [
            { service: 'home-assistant' },
            { service: 'nginx' },
        ];
        mockProducer.resolveServiceDataDir.mockImplementation(async (svc: string) => `/mnt/data/stacks/${svc}`);
        mockProducer.buildServiceBackupTar.mockResolvedValue(await buildTar({ 'nginx.conf': 'x' }));

        const metadata = { version: 3, createdAt: '', nodes: [], configFiles: [] };
        await stageServiceConfig(tmpRoot, metadata as never, [], undefined);

        const sd = (metadata as { serviceData: Array<{ service: string }> }).serviceData;
        expect(sd.map(e => e.service)).toEqual(['nginx']);
        expect(mockProducer.buildServiceBackupTar).toHaveBeenCalledTimes(1);
    });

    it('runs the collector when the manifest declares one', async () => {
        mockCfg.getConfig.mockResolvedValue({ installedTemplates: { npm: {} } });
        const collectedManifest = { service: 'npm', collected: true };
        mockManifest.SERVICE_BACKUP_MANIFESTS = [{ service: 'npm', collector: 'snapshot' }];
        mockProducer.resolveServiceDataDir.mockResolvedValue('/mnt/data/stacks/npm');
        mockProducer.runBackupCollector.mockResolvedValue(collectedManifest);
        mockProducer.buildServiceBackupTar.mockResolvedValue(await buildTar({ 'npm.conf': 'x' }));

        await stageServiceConfig(tmpRoot, { version: 3, createdAt: '', nodes: [], configFiles: [] } as never, [], undefined);

        expect(mockProducer.runBackupCollector).toHaveBeenCalledWith(
            expect.objectContaining({ service: 'npm' }),
            'Local',
        );
        // The collector's effective manifest is what gets tarred.
        expect(mockProducer.buildServiceBackupTar).toHaveBeenCalledWith('/mnt/data/stacks/npm', collectedManifest, expect.anything());
    });

    it('treats "No config files to back up" as a skip, not an error, and continues', async () => {
        mockCfg.getConfig.mockResolvedValue({ installedTemplates: { a: {}, b: {} } });
        mockManifest.SERVICE_BACKUP_MANIFESTS = [{ service: 'a' }, { service: 'b' }];
        mockProducer.resolveServiceDataDir.mockImplementation(async (svc: string) => `/mnt/data/stacks/${svc}`);
        mockProducer.buildServiceBackupTar.mockImplementation(async (_dir: string, m: { service: string }) => {
            if (m.service === 'a') throw new Error('No config files to back up');
            return buildTar({ 'b.conf': 'x' });
        });

        const logs: Array<{ status: string; message: string }> = [];
        const staged = await stageServiceConfig(tmpRoot, { version: 3, createdAt: '', nodes: [], configFiles: [] } as never, logs as never, undefined);

        expect(staged).toBe(true); // b still contributed
        expect(logs.some(l => l.status === 'skip' && /a: No config files/.test(l.message))).toBe(true);
        expect(logs.some(l => l.status === 'error')).toBe(false);
    });

    it('logs an error (not skip) for an unexpected per-service failure and returns false when nothing staged', async () => {
        mockCfg.getConfig.mockResolvedValue({ installedTemplates: { a: {} } });
        mockManifest.SERVICE_BACKUP_MANIFESTS = [{ service: 'a' }];
        mockProducer.resolveServiceDataDir.mockResolvedValue('/mnt/data/stacks/a');
        mockProducer.buildServiceBackupTar.mockRejectedValue(new Error('disk exploded'));

        const logs: Array<{ status: string; message: string }> = [];
        const staged = await stageServiceConfig(tmpRoot, { version: 3, createdAt: '', nodes: [], configFiles: [] } as never, logs as never, undefined);

        expect(staged).toBe(false);
        expect(logs.some(l => l.status === 'error' && /a: disk exploded/.test(l.message))).toBe(true);
    });
});

describe('extractServiceConfigToNode', () => {
    /** A fake host executor backed by a real temp dir, so the host-side
     *  base64/tar/find/readlink commands operate on actual files. */
    function fakeHostExecutor(hostRoot: string): Executor {
        const files = new Map<string, string>();
        const exec: Partial<Executor> = {
            writeFile: vi.fn(async (p: string, content: string) => { files.set(p, content); }),
            execArgv: vi.fn(async (argv: string[]) => {
                const [cmd, ...rest] = argv;
                if (cmd === 'mktemp') {
                    const f = path.join(hostRoot, `mktemp-${Math.random().toString(36).slice(2)}`);
                    return { stdout: f + '\n', stderr: '' };
                }
                if (cmd === 'sh' && rest[0] === '-c') {
                    // argv: ['sh','-c',<script>,'sh',<b64path>,<tarpath>]
                    // → rest = ['-c',<script>,'sh',<b64path>,<tarpath>]
                    const b64Path = rest[3];
                    const outPath = rest[4];
                    const b64 = files.get(b64Path) ?? '';
                    await fs.writeFile(outPath, Buffer.from(b64, 'base64'));
                    return { stdout: '', stderr: '' };
                }
                if (cmd === 'mkdir') {
                    await fs.mkdir(rest[rest.length - 1], { recursive: true });
                    return { stdout: '', stderr: '' };
                }
                if (cmd === 'tar') {
                    // tar -xf <hostTar> -C <destDir> ...
                    const fIdx = argv.indexOf('-xf');
                    const cIdx = argv.indexOf('-C');
                    await execFileAsync('tar', ['-xf', argv[fIdx + 1], '-C', argv[cIdx + 1], '--no-same-owner']);
                    return { stdout: '', stderr: '' };
                }
                if (cmd === 'readlink') {
                    const target = rest[rest.length - 1];
                    const resolved = await fs.realpath(target).catch(() => target);
                    return { stdout: resolved + '\n', stderr: '' };
                }
                if (cmd === 'find') {
                    // find <dir> -type l
                    const dir = rest[0];
                    const out: string[] = [];
                    const walk = async (d: string): Promise<void> => {
                        for (const ent of await fs.readdir(d, { withFileTypes: true })) {
                            const full = path.join(d, ent.name);
                            if (ent.isSymbolicLink()) out.push(full);
                            else if (ent.isDirectory()) await walk(full);
                        }
                    };
                    await walk(dir).catch(() => {});
                    return { stdout: out.join('\n') + '\n', stderr: '' };
                }
                if (cmd === 'rm') {
                    for (const a of rest) {
                        if (a.startsWith('/')) await fs.rm(a, { recursive: true, force: true }).catch(() => {});
                    }
                    return { stdout: '', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            }),
        };
        return exec as Executor;
    }

    it('extracts a plain config tar onto the node host dir via the agent', async () => {
        const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-host-'));
        const destDir = path.join(hostRoot, 'stacks', 'home-assistant');
        const tar = await buildTar({ 'configuration.yaml': 'default_config:', '.storage/x': 'secret' });

        await extractServiceConfigToNode(fakeHostExecutor(hostRoot), tar, destDir);

        await expect(fs.readFile(path.join(destDir, 'configuration.yaml'), 'utf8')).resolves.toBe('default_config:');
        await expect(fs.readFile(path.join(destDir, '.storage', 'x'), 'utf8')).resolves.toBe('secret');
        await fs.rm(hostRoot, { recursive: true, force: true });
    });

    it('refuses an archive with a traversal entry before touching the host', async () => {
        // Hand-build a tar carrying a `../escape` member.
        const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'evil-stage-'));
        await fs.mkdir(path.join(stage, 'sub'), { recursive: true });
        await fs.writeFile(path.join(stage, 'sub', 'escape'), 'x');
        const tarPath = path.join(stage, 'evil.tar');
        // Add the file under a ../-prefixed name.
        await execFileAsync('tar', ['-cf', tarPath, '-C', path.join(stage, 'sub'), '--transform', 's,^,../,', 'escape']);
        const tar = await fs.readFile(tarPath);
        await fs.rm(stage, { recursive: true, force: true });

        const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-host-'));
        const exec = fakeHostExecutor(hostRoot);
        await expect(
            extractServiceConfigToNode(exec, tar, path.join(hostRoot, 'dest')),
        ).rejects.toThrow(/traversal/i);
        // Pre-pass refused before any host write happened.
        expect(exec.writeFile).not.toHaveBeenCalled();
        await fs.rm(hostRoot, { recursive: true, force: true });
    });
});
