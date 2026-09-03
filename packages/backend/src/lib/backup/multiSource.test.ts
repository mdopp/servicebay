/**
 * Partial multi-source backup failures name every source (#2773).
 *
 * The loop over configured sources in `runBackupItems` had no per-source
 * try/catch, so a throw from source 2 of 2 propagated straight past the source
 * that had already synced. `runBackup`'s catch then recorded the WHOLE run as
 * failed carrying only that one source's bare rsync error — in the history
 * entry AND in the failure-alert email — so the operator had no way to tell
 * whether the first source's data had landed on the target.
 *
 * Same "denominator honesty" the install runner applies in
 * `summariseIncompleteRun` (packages/backend/src/lib/install/runner.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BackupConfig } from './types';

const {
    getConfig, updateConfig, sendEmailAlert, atomicWriteFile, execFileAsync,
    fsStat, fsAccess, fsReadFile,
} = vi.hoisted(() => ({
    getConfig: vi.fn(),
    updateConfig: vi.fn(async () => undefined),
    sendEmailAlert: vi.fn(async (_subject: string, _body: string) => undefined),
    atomicWriteFile: vi.fn(async (_file: string, _data: string) => undefined),
    execFileAsync: vi.fn(),
    fsStat: vi.fn(),
    fsAccess: vi.fn(),
    fsReadFile: vi.fn(),
}));

vi.mock('../config', () => ({ getConfig, updateConfig }));
vi.mock('../email', () => ({ sendEmailAlert }));
vi.mock('../util/atomicWrite', () => ({ atomicWriteFile }));

// `service.ts` uses `promisify(execFile)`; promisify honours the custom symbol,
// so the mock only has to expose the promise form the service actually calls.
vi.mock('node:child_process', () => {
    const execFile = () => {
        throw new Error('the callback form of execFile is not used by the backup service');
    };
    (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = execFileAsync;
    return { execFile, default: { execFile } };
});

vi.mock('fs/promises', () => {
    const api = { stat: fsStat, access: fsAccess, readFile: fsReadFile };
    return { ...api, default: api };
});

const { runBackup, summariseBackupRun } = await import('./service');

const ALPHA = '/srv/alpha';
const BETA = '/srv/beta';
const RSYNC_ERROR = 'rsync: [sender] change_dir "/srv/beta" failed: Permission denied (13)';

const config: BackupConfig = {
    enabled: true,
    schedule: 'daily',
    time: '02:00',
    target: { type: 'local', path: '/mnt/backup' },
    sources: [{ path: ALPHA }, { path: BETA }],
};

const RSYNC_STDOUT = [
    'Number of regular files transferred: 12',
    'Total transferred file size: 1,024 bytes',
].join('\n');

beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ backup: config });
    // Target on its own device (the same-disk guard must not fire).
    fsStat.mockImplementation(async (p: string) => ({
        isDirectory: () => true,
        dev: p === '/mnt/backup' ? 1 : 2,
    }));
    fsAccess.mockResolvedValue(undefined);
    fsReadFile.mockRejectedValue(new Error('ENOENT')); // empty history
    // Source 1 syncs; source 2's rsync fails.
    execFileAsync.mockImplementation(async (_bin: string, args: string[]) => {
        if (args.some(a => a.startsWith(BETA))) throw new Error(RSYNC_ERROR);
        return { stdout: RSYNC_STDOUT, stderr: '' };
    });
});

describe('runBackup — partial multi-source failure (#2773)', () => {
    it('names BOTH outcomes in the result, not just the failing source\'s error', async () => {
        const result = await runBackup();

        expect(result.success).toBe(false);
        // The source that DID sync must be named — the denominator, not just the error.
        expect(result.message).toContain(ALPHA);
        expect(result.message).toContain(BETA);
        expect(result.message).toContain('1/2');
        expect(result.message).toContain(RSYNC_ERROR);
        // The old failure mode: the message was exactly source 2's bare error.
        expect(result.message).not.toBe(RSYNC_ERROR);
    });

    it('still attempts the remaining sources after an earlier one throws', async () => {
        // Failing source FIRST: the pre-fix loop stopped the run right here and
        // never touched the second source at all.
        getConfig.mockResolvedValue({
            backup: { ...config, sources: [{ path: BETA }, { path: ALPHA }] },
        });

        await runBackup();

        const rsyncCalls = execFileAsync.mock.calls.filter(([bin]) => bin === 'rsync');
        expect(rsyncCalls).toHaveLength(2);
    });

    it('writes the both-outcomes summary into the history entry', async () => {
        await runBackup();

        expect(atomicWriteFile).toHaveBeenCalled();
        const written = String(atomicWriteFile.mock.calls.at(-1)?.[1] ?? '');
        expect(written).toContain(ALPHA);
        expect(written).toContain(BETA);
    });

    it('sends a failure alert that names the synced source as well as the failed one', async () => {
        await runBackup();

        expect(sendEmailAlert).toHaveBeenCalled();
        const body = String(sendEmailAlert.mock.calls.at(-1)?.[1] ?? '');
        expect(body).toContain(ALPHA);
        expect(body).toContain(BETA);
    });

    it('reports a clean success when every source syncs', async () => {
        execFileAsync.mockResolvedValue({ stdout: RSYNC_STDOUT, stderr: '' });

        const result = await runBackup();

        expect(result.success).toBe(true);
        expect(result.message).toContain('2 sources');
    });

    it('says nothing was synced when every source fails', async () => {
        execFileAsync.mockImplementation(async (bin: string) => {
            if (bin === 'rsync') throw new Error(RSYNC_ERROR);
            return { stdout: '', stderr: '' };
        });

        const result = await runBackup();

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/0 of 2/);
        expect(result.message).toContain(ALPHA);
        expect(result.message).toContain(BETA);
    });
});

describe('summariseBackupRun — the denominator, not just the error', () => {
    it('names the synced sources alongside the failed one', () => {
        const line = summariseBackupRun([ALPHA], [{ path: BETA, error: 'boom' }]);

        expect(line).toContain('1/2');
        expect(line).toContain(ALPHA);
        expect(line).toContain(`${BETA} — boom`);
    });

    it('states plainly when nothing reached the target', () => {
        const line = summariseBackupRun([], [
            { path: ALPHA, error: 'boom' },
            { path: BETA, error: 'bang' },
        ]);

        expect(line).toContain('0 of 2');
        expect(line).toContain(ALPHA);
        expect(line).toContain(BETA);
    });

    it('reports a full sync with its own denominator', () => {
        expect(summariseBackupRun([ALPHA, BETA], [])).toContain('2/2');
    });
});
