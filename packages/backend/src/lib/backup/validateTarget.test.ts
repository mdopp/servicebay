/**
 * Local-target validation parity between Test Connection and Run (#1612).
 *
 * The old `ensureTargetDir` did `fs.mkdir(target.path, { recursive: true })`
 * on the Run path, silently creating a non-mounted mountpoint as a plain dir
 * on the OS/boot disk and rsyncing everything onto the same machine. Test and
 * Run now share `validateLocalTarget` (exercised here via `testBackupTarget`):
 *   - the target must already exist and be a directory (no mkdir),
 *   - and may not sit on the same filesystem/device as a source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { testBackupTarget } from './service';
import type { BackupTarget, BackupSource } from './types';

let tmpRoot: string;

beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-backup-validate-'));
});

afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('testBackupTarget — local target validation (#1612)', () => {
    it('fails (ENOENT) when the target path does not exist — never creates it', async () => {
        const missing = path.join(tmpRoot, 'not-mounted');
        const target: BackupTarget = { type: 'local', path: missing };

        const res = await testBackupTarget(target);

        expect(res.success).toBe(false);
        expect(res.message).toMatch(/ENOENT|no such file/i);
        // Critically: the path must NOT have been created.
        await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails when the target exists but is a file, not a directory', async () => {
        const filePath = path.join(tmpRoot, 'afile');
        await fs.writeFile(filePath, 'x');
        const target: BackupTarget = { type: 'local', path: filePath };

        const res = await testBackupTarget(target);

        expect(res.success).toBe(false);
        expect(res.message).toMatch(/not a directory/i);
    });

    it('refuses a target on the same filesystem as a source (same-disk backup)', async () => {
        // Two dirs under the same tmp root share a device → must be refused.
        const targetDir = path.join(tmpRoot, 'target');
        const sourceDir = path.join(tmpRoot, 'source');
        await fs.mkdir(targetDir);
        await fs.mkdir(sourceDir);
        const target: BackupTarget = { type: 'local', path: targetDir };
        const sources: BackupSource[] = [{ path: sourceDir }];

        const res = await testBackupTarget(target, sources);

        expect(res.success).toBe(false);
        expect(res.message).toMatch(/same filesystem|same disk/i);
    });

    it('passes for an existing, writable directory when no sources are given (device check skipped)', async () => {
        const targetDir = path.join(tmpRoot, 'target');
        await fs.mkdir(targetDir);
        const target: BackupTarget = { type: 'local', path: targetDir };

        const res = await testBackupTarget(target);

        expect(res.success).toBe(true);
        // The write-probe sentinel must have been cleaned up.
        await expect(fs.stat(path.join(targetDir, '.servicebay-backup-test'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
