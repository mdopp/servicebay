import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Executor } from './executor';

const execFileAsync = promisify(execFile);

// stageServiceConfig now delegates the heavy walk/copy/tar to the resource-capped
// backup worker (#1955): the worker writes <service>.tar to a shared out dir, and
// stageServiceConfig reads each tar (via readBackupTar) and safeTarExtracts it
// into the archive. We mock the worker service so the test drives the worker's
// status results + tar bytes without launching a container.
const { mockWorker, mockCfg } = vi.hoisted(() => ({
    mockWorker: {
        stageInstalledServiceConfigViaWorker: vi.fn(),
        readBackupTar: vi.fn(),
        cleanupBackupRun: vi.fn(),
    },
    mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn() },
}));

vi.mock('./backupWorker/service', () => mockWorker);
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

interface SvcDataEntry { label: string; service: string; sourcePath: string; nodeName: string }
/** A BackupMetadata-shaped object whose serviceData is the new typed-entry form. */
function makeMeta(): { version: number; createdAt: string; nodes: never[]; configFiles: never[]; serviceData: SvcDataEntry[] } {
    return { version: 3, createdAt: '', nodes: [], configFiles: [], serviceData: [] };
}

let tmpRoot: string;

/** Build a worker status doc with the given per-service results. */
function workerStatus(results: Array<{ service: string; ok: boolean; tarName?: string | null; outcome?: 'ok' | 'skip' | 'error'; detail?: string | null }>) {
    return {
        version: 1, runId: 'r', phase: 'done', step: 'done', total: results.length, processed: results.length,
        results: results.map(r => ({
            service: r.service, ok: r.ok, tarName: r.tarName ?? (r.ok ? `${r.service}.tar` : null),
            bytes: 0, files: 0, outcome: r.outcome ?? (r.ok ? 'ok' : 'error'), detail: r.detail ?? null,
        })),
        error: null, updatedAt: 0, startedAt: 0,
    };
}

/** Wire the worker mock: status results + per-tar bytes keyed by tarName. */
function wireWorker(status: ReturnType<typeof workerStatus>, tars: Record<string, Buffer> = {}) {
    const run = { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' };
    const exec = vi.fn();
    mockWorker.stageInstalledServiceConfigViaWorker.mockResolvedValue({ exec, run, status });
    mockWorker.readBackupTar.mockImplementation(async (_e: unknown, _r: unknown, tarName: string) => {
        const buf = tars[tarName];
        if (!buf) throw new Error(`no tar for ${tarName}`);
        return buf;
    });
    mockWorker.cleanupBackupRun.mockResolvedValue(undefined);
}

beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sysbackup-svccfg-'));
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: {} });
});

afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('stageServiceConfig', () => {
    it('extracts each worker-produced tar into service-config/<svc>/ and records metadata', async () => {
        wireWorker(
            workerStatus([{ service: 'home-assistant', ok: true }, { service: 'nginx', ok: true }]),
            {
                'home-assistant.tar': await buildTar({ 'home-assistant.conf': 'cfg for home-assistant' }),
                'nginx.tar': await buildTar({ 'nginx.conf': 'cfg for nginx' }),
            },
        );

        const metadata = makeMeta();
        const logs: unknown[] = [];
        const staged = await stageServiceConfig(tmpRoot, metadata as never, logs as never, undefined);

        expect(staged).toBe(true);
        const haFile = path.join(tmpRoot, 'service-config', 'home-assistant', 'home-assistant.conf');
        const nginxFile = path.join(tmpRoot, 'service-config', 'nginx', 'nginx.conf');
        await expect(fs.readFile(haFile, 'utf8')).resolves.toBe('cfg for home-assistant');
        await expect(fs.readFile(nginxFile, 'utf8')).resolves.toBe('cfg for nginx');
        // The per-service tmp tar is cleaned up.
        await expect(fs.access(path.join(tmpRoot, 'service-config', 'home-assistant.tar'))).rejects.toThrow();
        // The worker run's out dir is cleaned up.
        expect(mockWorker.cleanupBackupRun).toHaveBeenCalledTimes(1);
        // Metadata records {label, service, sourcePath, nodeName}.
        const sd = metadata.serviceData;
        expect(sd).toEqual([
            { label: 'home-assistant', service: 'home-assistant', sourcePath: 'home-assistant', nodeName: 'Local' },
            { label: 'nginx', service: 'nginx', sourcePath: 'nginx', nodeName: 'Local' },
        ]);
    });

    it('returns false when no installed service has a backup manifest', async () => {
        mockWorker.stageInstalledServiceConfigViaWorker.mockResolvedValue(null);
        const metadata = makeMeta();
        const staged = await stageServiceConfig(tmpRoot, metadata as never, [], undefined);
        expect(staged).toBe(false);
        expect(metadata.serviceData).toEqual([]);
    });

    it('treats a worker "skip" outcome as a skip log, not an error, and continues', async () => {
        wireWorker(
            workerStatus([
                { service: 'a', ok: false, outcome: 'skip', detail: 'No config files to back up' },
                { service: 'b', ok: true },
            ]),
            { 'b.tar': await buildTar({ 'b.conf': 'x' }) },
        );

        const logs: Array<{ status: string; message: string }> = [];
        const staged = await stageServiceConfig(tmpRoot, { version: 3, createdAt: '', nodes: [], configFiles: [] } as never, logs as never, undefined);

        expect(staged).toBe(true); // b still contributed
        expect(logs.some(l => l.status === 'skip' && /a: No config files/.test(l.message))).toBe(true);
        expect(logs.some(l => l.status === 'error')).toBe(false);
    });

    it('logs an error (not skip) for a worker error outcome and returns false when nothing staged', async () => {
        wireWorker(workerStatus([{ service: 'a', ok: false, outcome: 'error', detail: 'disk exploded' }]));

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
