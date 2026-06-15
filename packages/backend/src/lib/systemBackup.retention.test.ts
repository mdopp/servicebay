import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

/**
 * Covers #1868: persisted `kind` via filename suffix, pre-mutation dedup,
 * and auto-only retention/prune. Uses a real temp DATA_DIR (mocked `./dirs`)
 * and real `tar`; mocks the heavy node/service staging deps so the test
 * exercises only the kind/dedup/prune logic.
 */

const { dataDir, backupDir } = vi.hoisted(() => {
    // Runs before static imports init — build paths from string literals only
    // (no `path`/`os`). TMPDIR covers non-/tmp CI runners.
    const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
    const base = `${tmp}/sb-retention-${Date.now()}-${process.pid}`;
    return { dataDir: base, backupDir: `${base}/backups` };
});

vi.mock('./dirs', () => ({
    DATA_DIR: dataDir,
    SERVICEBAY_BACKUP_DIR: backupDir,
    SSH_DIR: path.join(dataDir, 'ssh'),
    getLocalSystemdDir: () => path.join(dataDir, 'no-such-systemd'),
}));

vi.mock('./nodes', () => ({ listNodes: vi.fn(async () => []) }));
vi.mock('./config', () => ({ getConfig: vi.fn(async () => ({ installedTemplates: {} })), updateConfig: vi.fn() }));
// stageServiceConfig pulls these in lazily — return "nothing staged".
vi.mock('./externalBackup/serviceManifest', () => ({ SERVICE_BACKUP_MANIFESTS: [], getBackupGate: (m: { service: string }) => m.service }));
vi.mock('./externalBackup/producer', () => ({
    buildServiceBackupTar: vi.fn(),
    agentFileBackend: vi.fn(() => ({})),
    resolveServiceDataDir: vi.fn(),
    runBackupCollector: vi.fn(),
}));
vi.mock('./executor', () => ({ getExecutor: vi.fn(() => ({})) }));
vi.mock('./ssh/pool', () => ({ SSHConnectionPool: { getInstance: () => ({ getConnection: vi.fn() }) } }));

import {
    createSystemBackup,
    listSystemBackups,
    autoSnapshotWouldDuplicate,
    AUTO_BACKUP_RETENTION,
} from './systemBackup';

async function writeConfig(value: string) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'config.json'), value);
}

/** Drop a fake snapshot file straight into the backup dir (no real archive). */
async function seedSnapshot(fileName: string) {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, fileName), 'x');
    // Stagger mtimes so newest-first sort is deterministic.
    await new Promise(r => setTimeout(r, 2));
}

beforeEach(async () => {
    vi.clearAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
    await writeConfig('{"version":1}');
});

afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe('kind suffix', () => {
    it('auto snapshots get a -auto suffix, manual get -manual', async () => {
        const auto = await createSystemBackup('auto');
        const manual = await createSystemBackup('manual');
        expect(auto.entry.fileName).toMatch(/-auto\.tar\.gz$/);
        expect(auto.entry.kind).toBe('auto');
        expect(manual.entry.fileName).toMatch(/-manual\.tar\.gz$/);
        expect(manual.entry.kind).toBe('manual');
    });

    it('listSystemBackups surfaces kind, classifying unsuffixed legacy files as legacy', async () => {
        await seedSnapshot('servicebay-full-2020-01-01T00-00-00-000Z.tar.gz'); // legacy, no suffix
        await createSystemBackup('auto');
        await createSystemBackup('manual');
        const list = await listSystemBackups();
        const byKind = (k: string) => list.filter(e => e.kind === k).length;
        expect(byKind('legacy')).toBe(1);
        expect(byKind('auto')).toBe(1);
        expect(byKind('manual')).toBe(1);
    });
});

describe('dedup (snapshotBeforeMutation path)', () => {
    it('skips when config is byte-identical to the latest auto snapshot', async () => {
        await createSystemBackup('auto');
        // Config unchanged → a new auto snapshot would duplicate.
        expect(await autoSnapshotWouldDuplicate()).toBe(true);
    });

    it('does NOT skip when config changed since the latest auto snapshot', async () => {
        await createSystemBackup('auto');
        await writeConfig('{"version":2}');
        expect(await autoSnapshotWouldDuplicate()).toBe(false);
    });

    it('does NOT skip when there is no prior auto snapshot (only manual/legacy)', async () => {
        await seedSnapshot('servicebay-full-2020-01-01T00-00-00-000Z.tar.gz');
        await createSystemBackup('manual');
        expect(await autoSnapshotWouldDuplicate()).toBe(false);
    });
});

describe('retention / prune', () => {
    it(`keeps only the newest ${AUTO_BACKUP_RETENTION} auto snapshots`, async () => {
        // Seed RETENTION+5 auto snapshots, then trigger one more real auto
        // backup which runs the prune.
        for (let i = 0; i < AUTO_BACKUP_RETENTION + 5; i++) {
            await seedSnapshot(`servicebay-full-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z-auto.tar.gz`);
        }
        await createSystemBackup('auto'); // newest; prune runs after write
        const autos = (await listSystemBackups()).filter(e => e.kind === 'auto');
        expect(autos).toHaveLength(AUTO_BACKUP_RETENTION);
    });

    it('never prunes manual snapshots', async () => {
        for (let i = 0; i < 5; i++) {
            await seedSnapshot(`servicebay-full-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z-manual.tar.gz`);
        }
        // Far exceed retention with auto snapshots so prune is forced.
        for (let i = 0; i < AUTO_BACKUP_RETENTION + 5; i++) {
            await seedSnapshot(`servicebay-full-2020-02-01T00-00-${String(i).padStart(2, '0')}-000Z-auto.tar.gz`);
        }
        await createSystemBackup('auto');
        const list = await listSystemBackups();
        expect(list.filter(e => e.kind === 'manual')).toHaveLength(5);
        expect(list.filter(e => e.kind === 'auto')).toHaveLength(AUTO_BACKUP_RETENTION);
    });

    it('never prunes legacy unsuffixed snapshots', async () => {
        for (let i = 0; i < 30; i++) {
            await seedSnapshot(`servicebay-full-2019-01-01T00-00-${String(i).padStart(2, '0')}-000Z.tar.gz`);
        }
        for (let i = 0; i < AUTO_BACKUP_RETENTION + 5; i++) {
            await seedSnapshot(`servicebay-full-2020-02-01T00-00-${String(i).padStart(2, '0')}-000Z-auto.tar.gz`);
        }
        await createSystemBackup('auto');
        const list = await listSystemBackups();
        // All 30 legacy files survive; the 8203-pile cleanup is out-of-band.
        expect(list.filter(e => e.kind === 'legacy')).toHaveLength(30);
        expect(list.filter(e => e.kind === 'auto')).toHaveLength(AUTO_BACKUP_RETENTION);
    });

    it('manual snapshots do NOT trigger a prune of auto snapshots', async () => {
        for (let i = 0; i < AUTO_BACKUP_RETENTION + 5; i++) {
            await seedSnapshot(`servicebay-full-2020-02-01T00-00-${String(i).padStart(2, '0')}-000Z-auto.tar.gz`);
        }
        await createSystemBackup('manual'); // manual path must not prune
        const autos = (await listSystemBackups()).filter(e => e.kind === 'auto');
        expect(autos).toHaveLength(AUTO_BACKUP_RETENTION + 5);
    });
});
