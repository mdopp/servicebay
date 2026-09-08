/**
 * "Back up now" picks the mechanism the box can actually run (#2872).
 *
 * The regression this locks down: `config.backup.target` on the reference box
 * held probe residue — `{ type: 'local', path: '/mnt/backup', host:
 * 'probe-verify.invalid', share: 'probe', username: 'probe' }`, `enabled:
 * false` — so every `run_backup` chose the Backup-Sync branch and died in 0 s
 * on `ENOENT ... access '/mnt/backup'`. Nothing was backed up, no other path
 * was tried, and the fix has to work on that stored config as-is, without
 * anyone editing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackupConfig, BackupTarget } from './types';

const { getConfig, updateConfig, sendEmailAlert, atomicWriteFile, statPaths, stat, backupInstalledServicesToNas } =
    vi.hoisted(() => {
        const statPaths: string[] = [];
        return {
            getConfig: vi.fn(async () => ({}) as Record<string, unknown>),
            updateConfig: vi.fn(async () => undefined),
            sendEmailAlert: vi.fn(async () => undefined),
            atomicWriteFile: vi.fn(async () => undefined),
            backupInstalledServicesToNas: vi.fn(async () => [] as unknown[]),
            statPaths,
            // Only `/mnt/real-disk` is a mounted directory here; everything else
            // is ENOENT, exactly like `/mnt/backup` on the box.
            stat: vi.fn(async (p: string) => {
                statPaths.push(p);
                if (p === '/mnt/real-disk') return { isDirectory: () => true, dev: 42 };
                throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });
            }),
        };
    });

vi.mock('../config', () => ({ getConfig, updateConfig }));
vi.mock('../email', () => ({ sendEmailAlert }));
vi.mock('../util/atomicWrite', () => ({ atomicWriteFile }));
vi.mock('../externalBackup/producer', () => ({
    backupInstalledServicesToNas,
    // The real one-liner would drag the whole producer in; its own tally rules
    // are covered by `externalBackup/producer.test.ts`.
    summariseBackupRun: (results: { ok: boolean }[]) =>
        `${results.filter(r => r.ok).length}/${results.length} services backed up`,
}));
vi.mock('fs/promises', async importActual => {
    const actual = await importActual<Record<string, unknown>>();
    const base = (actual.default as Record<string, unknown>) ?? actual;
    const patched = { ...base, stat, readFile: vi.fn(async () => { throw new Error('no history file'); }) };
    return { ...actual, ...patched, default: patched };
});

const { runBackupNow, NAS_FALLBACK_PREFIX } = await import('./runNow');

/** The exact residue the box carries, `enabled: false` and all. */
const PROBE_RESIDUE_TARGET = {
    type: 'local',
    path: '/mnt/backup',
    host: 'probe-verify.invalid',
    share: 'probe',
    username: 'probe',
} as unknown as BackupTarget;

function config(target: BackupTarget, over: Partial<BackupConfig> = {}): BackupConfig {
    return { enabled: false, schedule: 'daily', time: '02:00', target, ...over };
}

beforeEach(() => {
    vi.clearAllMocks();
    statPaths.length = 0;
    backupInstalledServicesToNas.mockResolvedValue([]);
});

describe('runBackupNow — no real content target falls back to the NAS config backup', () => {
    it('runs the NAS producer for the probe residue, and never touches /mnt/backup', async () => {
        getConfig.mockResolvedValue({ backup: config(PROBE_RESIDUE_TARGET, { sources: [{ path: '/mnt/data' }] }) });
        backupInstalledServicesToNas.mockResolvedValue([
            { service: 'auth', ok: true, tarName: 'auth-2026-09-08.tar', size: 1024 },
            { service: 'nginx', ok: true, tarName: 'nginx-2026-09-08.tar', size: 2048 },
        ]);

        const result = await runBackupNow();

        expect(backupInstalledServicesToNas).toHaveBeenCalledTimes(1);
        expect(result.kind).toBe('nas-config');
        expect(result.success).toBe(true);
        expect(result.servicesOk).toBe(2);
        expect(result.servicesTotal).toBe(2);
        expect(result.services?.map(s => s.tarName)).toEqual(['auth-2026-09-08.tar', 'nginx-2026-09-08.tar']);
        expect(result.message).toContain(NAS_FALLBACK_PREFIX);
        expect(result.message).toContain('2/2 services backed up');
        // The whole point: the phantom path is never even probed, so the old
        // 0-second ENOENT cannot come back.
        expect(statPaths).not.toContain('/mnt/backup');
        expect(result.message).not.toMatch(/ENOENT/);
    });

    it('runs the NAS producer when no backup config exists at all', async () => {
        getConfig.mockResolvedValue({});

        const result = await runBackupNow();

        expect(backupInstalledServicesToNas).toHaveBeenCalledTimes(1);
        expect(result.kind).toBe('nas-config');
    });

    it('runs the NAS producer for a plain local target whose path is not mounted here', async () => {
        getConfig.mockResolvedValue({ backup: config({ type: 'local', path: '/mnt/backup' }) });

        const result = await runBackupNow();

        expect(backupInstalledServicesToNas).toHaveBeenCalledTimes(1);
        expect(result.kind).toBe('nas-config');
    });

    it('reports a failed NAS run as a failure rather than a silent success', async () => {
        getConfig.mockResolvedValue({ backup: config(PROBE_RESIDUE_TARGET) });
        backupInstalledServicesToNas.mockResolvedValue([
            { service: 'auth', ok: true, tarName: 'auth.tar' },
            { service: 'nginx', ok: false, error: 'no space left on device' },
        ]);

        const result = await runBackupNow();

        expect(result.success).toBe(false);
        expect(result.servicesOk).toBe(1);
        expect(result.servicesTotal).toBe(2);
    });

    it('surfaces a producer throw as a failed nas-config run', async () => {
        getConfig.mockResolvedValue({ backup: config(PROBE_RESIDUE_TARGET) });
        backupInstalledServicesToNas.mockRejectedValue(new Error('worker never came up'));

        const result = await runBackupNow();

        expect(result.kind).toBe('nas-config');
        expect(result.success).toBe(false);
        expect(result.message).toContain('worker never came up');
    });
});

describe('runBackupNow — a real content target keeps Backup-Sync semantics', () => {
    it('runs Backup Sync for an smb target and never calls the NAS producer', async () => {
        getConfig.mockResolvedValue({
            backup: config({ type: 'smb', host: 'nas.lan', share: 'backup' }, { enabled: true }),
        });

        const result = await runBackupNow();

        expect(backupInstalledServicesToNas).not.toHaveBeenCalled();
        expect(result.kind).toBe('content-sync');
        // Backup Sync's own unchanged behaviour: sourceless config → its
        // pre-existing error, recorded and alerted exactly as before.
        expect(result.message).toBe('No backup sources configured');
        expect(atomicWriteFile).toHaveBeenCalled();
        expect(sendEmailAlert).toHaveBeenCalled();
    });

    it('runs Backup Sync for a local target whose path really is a mounted directory', async () => {
        getConfig.mockResolvedValue({ backup: config({ type: 'local', path: '/mnt/real-disk' }, { enabled: true }) });

        const result = await runBackupNow();

        expect(backupInstalledServicesToNas).not.toHaveBeenCalled();
        expect(result.kind).toBe('content-sync');
        expect(statPaths).toContain('/mnt/real-disk');
    });
});
