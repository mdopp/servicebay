/**
 * Manual "Run Backup Now" on a box that never configured Backup Sync (#2443).
 *
 * `loadBackupConfig()` used to assert past an absent `config.backup`
 * (`appConfig.backup!`), so `runBackup()` handed `undefined` to
 * `resolveBackupSources()` and the operator got a raw
 * "Cannot read properties of undefined (reading 'sources')" — plus a junk
 * failure record in the backup history and a "Backup Failed" email.
 * Unconfigured must now bail cleanly and say what's missing; a configured
 * run must behave exactly as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BackupConfig } from './types';

const { getConfig, updateConfig, sendEmailAlert, atomicWriteFile } = vi.hoisted(() => ({
    getConfig: vi.fn(async () => ({}) as Record<string, unknown>),
    updateConfig: vi.fn(async () => undefined),
    sendEmailAlert: vi.fn(async () => undefined),
    atomicWriteFile: vi.fn(async () => undefined),
}));

vi.mock('../config', () => ({ getConfig, updateConfig }));
vi.mock('../email', () => ({ sendEmailAlert }));
vi.mock('../util/atomicWrite', () => ({ atomicWriteFile }));

const { runBackup, BACKUP_NOT_CONFIGURED_MESSAGE } = await import('./service');

const configured: BackupConfig = {
    enabled: true,
    schedule: 'daily',
    time: '02:00',
    target: { type: 'local', path: '/mnt/backup' },
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('runBackup — backup never configured (#2443)', () => {
    it('returns a clear "not configured" message instead of crashing on undefined', async () => {
        // A box with only `externalBackup` set: `config.backup` is absent.
        getConfig.mockResolvedValue({ externalBackup: { target: 'nas' } });

        const result = await runBackup();

        expect(result.success).toBe(false);
        expect(result.message).toBe(BACKUP_NOT_CONFIGURED_MESSAGE);
        expect(result.message).toMatch(/isn't configured/i);
        // The old failure mode, spelled out so it can't come back.
        expect(result.message).not.toMatch(/Cannot read properties of undefined/);
    });

    it('records no history entry and sends no failure alert for an unconfigured run', async () => {
        getConfig.mockResolvedValue({});

        await runBackup();

        expect(atomicWriteFile).not.toHaveBeenCalled();
        expect(sendEmailAlert).not.toHaveBeenCalled();
    });
});

describe('runBackup — configured (unchanged behaviour)', () => {
    it('still runs the normal path when backup is configured, reporting the real error', async () => {
        // Configured but with no source dirs → the pre-existing
        // "No backup sources configured" failure, recorded + alerted as before.
        getConfig.mockResolvedValue({ backup: configured });

        const result = await runBackup();

        expect(result.success).toBe(false);
        expect(result.message).toBe('No backup sources configured');
        expect(atomicWriteFile).toHaveBeenCalled();
        expect(sendEmailAlert).toHaveBeenCalled();
    });

    it('honours an explicitly passed config — the scheduled-backup path is untouched', async () => {
        // scheduleBackup() passes its own config; `config.backup` being absent
        // in the stored config must not turn that into "not configured".
        getConfig.mockResolvedValue({});

        const result = await runBackup(configured);

        expect(result.message).toBe('No backup sources configured');
    });
});
