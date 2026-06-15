import { describe, it, expect, beforeEach, vi } from 'vitest';
import nodeFs from 'node:fs';

/**
 * CIFS mount must never inline the password into the comma-joined `-o` options
 * (a comma in the password would terminate the value and inject an arbitrary
 * mount option, e.g. uid=0). It writes a 0600 `credentials=` file instead and
 * passes only `credentials=<path>`. The file is removed after the mount call.
 *
 * We exercise the real `mountTarget` code path via `testBackupTarget`'s `smb`
 * case and capture, at mount time, the credentials file's contents + mode.
 */

const execCalls: { cmd: string; args: string[] }[] = [];
// Snapshot of the credentials file captured by the mocked `mount` call,
// because the production code deletes it again right after mount returns.
let credFileSnapshot: { path: string; content: string; mode: number } | null = null;

vi.mock('node:child_process', () => {
    // `nodeFs` (a top-level import of the real fs) is referenced lazily inside
    // the callback, which only runs during a test — long after top-level
    // imports have resolved — so the hoisted factory can safely close over it.
    const execFile = (
        cmd: string,
        args: string[],
        callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => {
        execCalls.push({ cmd, args: Array.isArray(args) ? [...args] : [] });
        // For a CIFS mount, read the credentials file referenced in `-o` so we
        // can assert its perms/content before the caller cleans it up.
        if (cmd === 'sudo' && args[0] === 'mount' && args.includes('cifs')) {
            const oIdx = args.indexOf('-o');
            const optsStr = oIdx >= 0 ? args[oIdx + 1] : '';
            const credOpt = optsStr.split(',').find((o) => o.startsWith('credentials='));
            if (credOpt) {
                const credPath = credOpt.slice('credentials='.length);
                const st = nodeFs.statSync(credPath);
                credFileSnapshot = {
                    path: credPath,
                    content: nodeFs.readFileSync(credPath, 'utf-8'),
                    mode: st.mode & 0o777,
                };
            }
        }
        callback(null, '', '');
    };
    return { execFile, default: { execFile } };
});

describe('mountTarget — CIFS credentials handling (comma-in-password injection)', () => {
    beforeEach(() => {
        execCalls.length = 0;
        credFileSnapshot = null;
        vi.resetModules();
    });

    it('mounts a comma-laden password via a 0600 credentials file, never inline in -o', async () => {
        const { testBackupTarget } = await import('./service');
        const password = 'p,a,s,s=uid=0,gid=0';
        const res = await testBackupTarget({
            type: 'smb',
            host: 'nas.local',
            share: 'backup',
            username: 'alice',
            password,
            domain: 'WORKGROUP',
        });

        expect(res.success).toBe(true);

        const mountCall = execCalls.find((c) => c.cmd === 'sudo' && c.args[0] === 'mount');
        expect(mountCall).toBeDefined();
        const oIdx = mountCall!.args.indexOf('-o');
        const opts = mountCall!.args[oIdx + 1];

        // The password (and the comma-injected option it carries) must NOT
        // appear anywhere in the joined -o string.
        expect(opts).not.toContain('password=');
        expect(opts).not.toContain(password);
        // Only a credentials= option references the secret material.
        expect(opts.split(',').some((o) => o.startsWith('credentials='))).toBe(true);

        // The credentials file existed at mount time, was 0600, and held the
        // password verbatim (commas intact).
        expect(credFileSnapshot).not.toBeNull();
        expect(credFileSnapshot!.mode).toBe(0o600);
        expect(credFileSnapshot!.content).toContain('username=alice');
        expect(credFileSnapshot!.content).toContain(`password=${password}`);
        expect(credFileSnapshot!.content).toContain('domain=WORKGROUP');
    });

    it('removes the credentials file after the mount completes', async () => {
        const fs = await import('fs/promises');
        const { testBackupTarget } = await import('./service');
        await testBackupTarget({
            type: 'smb',
            host: 'nas.local',
            share: 'backup',
            username: 'bob',
            password: 'plainpw',
        });

        expect(credFileSnapshot).not.toBeNull();
        // The file (and its private temp dir) must be gone post-mount.
        await expect(fs.stat(credFileSnapshot!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('uses guest (no credentials file) when no username is given', async () => {
        const { testBackupTarget } = await import('./service');
        const res = await testBackupTarget({
            type: 'smb',
            host: 'nas.local',
            share: 'public',
        });

        expect(res.success).toBe(true);
        expect(credFileSnapshot).toBeNull();
        const mountCall = execCalls.find((c) => c.cmd === 'sudo' && c.args[0] === 'mount');
        const opts = mountCall!.args[mountCall!.args.indexOf('-o') + 1];
        expect(opts.split(',')).toContain('guest');
        expect(opts).not.toContain('credentials=');
    });

    it('mounts NFS with no credentials option (unaffected by the CIFS change)', async () => {
        const { testBackupTarget } = await import('./service');
        const res = await testBackupTarget({
            type: 'nfs',
            host: 'nas.local',
            export: '/exports/backup',
        });

        expect(res.success).toBe(true);
        expect(credFileSnapshot).toBeNull();
        const mountCall = execCalls.find((c) => c.cmd === 'sudo' && c.args[0] === 'mount');
        expect(mountCall!.args).toContain('nfs');
        // NFS has no -o credentials path at all.
        expect(mountCall!.args.join(' ')).not.toContain('credentials=');
    });
});
