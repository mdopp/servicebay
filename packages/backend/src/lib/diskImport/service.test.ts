import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listImportDevices,
  scanDevice,
  applyImportPlan,
  __clearSessions,
} from './service';
import type { SafeExec, SafeExecResult } from './hostExec';

const ok = (stdout = ''): SafeExecResult => ({ stdout, stderr: '', code: 0 });

/**
 * SafeExec mock that dispatches by binary and records every argv. Mirrors the
 * agent contract (an error reply is a throw, not a returned `{error}`).
 */
function mockExec(
  byBinary: Record<string, SafeExecResult | ((argv: string[]) => SafeExecResult)> = {},
): { exec: SafeExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SafeExec = vi.fn(async (argv: string[]) => {
    calls.push(argv);
    const handler = byBinary[argv[0]];
    if (handler === undefined) return ok();
    return typeof handler === 'function' ? handler(argv) : handler;
  });
  return { exec, calls };
}

beforeEach(() => __clearSessions());

describe('listImportDevices', () => {
  it('keeps only removable partitions that carry a filesystem', async () => {
    const tree = {
      blockdevices: [
        {
          name: 'sda', path: '/dev/sda', size: 16e9, type: 'disk', rm: true,
          children: [
            { name: 'sda1', path: '/dev/sda1', size: 15e9, fstype: 'exfat', label: 'USB', type: 'part' },
          ],
        },
        { name: 'nvme0n1', path: '/dev/nvme0n1', size: 5e11, fstype: 'ext4', mountpoint: '/', type: 'disk', rm: false },
      ],
    };
    const { exec } = mockExec({ lsblk: ok(JSON.stringify(tree)) });
    const devices = await listImportDevices(exec);

    // sda1 (removable, has fstype) kept; nvme (not removable) + bare sda (no fstype) dropped.
    expect(devices.map(d => d.path)).toEqual(['/dev/sda1']);
    expect(devices[0].display).toContain('USB');
    expect(devices[0].display).toContain('exfat');
  });
});

/** A find listing of three files: two photos + one unknown-extension residue. */
const FIND_OUT = [
  '/mnt/photos/IMG_0001.jpg\t1000\t1700000000',
  '/mnt/photos/IMG_0002.jpg\t2000\t1700000001',
  '/mnt/misc/mystery.xyz\t3000\t1700000002',
].join('\0') + '\0';

describe('scanDevice', () => {
  it('mounts RO, scans, builds a plan, and unmounts — writing nothing to file-share', async () => {
    const { exec, calls } = mockExec({ find: ok(FIND_OUT) });
    const result = await scanDevice({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    // Mounted read-only and unmounted; no rsync/chown (no apply happened).
    expect(calls.some(c => c[0] === 'mount' && c.includes('ro'))).toBe(true);
    expect(calls.some(c => c[0] === 'umount')).toBe(true);
    expect(calls.some(c => c[0] === 'rsync')).toBe(false);
    expect(calls.some(c => c[0] === 'chown')).toBe(false);

    expect(result.sessionId).toBeTruthy();
    expect(result.totalFiles).toBe(3);
    expect(result.totalBytes).toBe(6000);
    expect(result.categories.find(c => c.category === 'photos')?.files).toBe(2);
  });

  it('surfaces the unclassifiable residue as a non-blocking ambiguous-folder action', async () => {
    const { exec } = mockExec({ find: ok(FIND_OUT) });
    const result = await scanDevice({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    const ambiguous = result.actions.filter(a => a.kind === 'ambiguous-folder');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].subject).toBe('/mnt/misc/mystery.xyz');
    expect(ambiguous[0].defaultOutcome).toMatch(/documents/);

    // The plan is complete despite the ambiguity — the residue still lands
    // (defaulted to documents), so the action annotates rather than blocks.
    expect(result.totalFiles).toBe(3);
    expect(result.categories.some(c => c.category === 'documents')).toBe(true);
  });
});

describe('applyImportPlan — the review gate', () => {
  it('refuses to apply without a scanned session (no host write)', async () => {
    const { exec, calls } = mockExec();
    await expect(
      applyImportPlan({ exec, sessionId: 'forged-id', shareGid: 1024 }),
    ).rejects.toThrow(/no reviewed plan/);
    // Nothing reached the host — no mount, no rsync.
    expect(calls).toHaveLength(0);
  });

  it('applies the exact plan from a prior scan and consumes the session', async () => {
    const { exec, calls } = mockExec({ find: ok(FIND_OUT) });
    const scan = await scanDevice({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    // No immich config wired → photos throw on apply; use a residue-only disk to
    // prove the copy path runs. Re-scan a docs-only listing.
    __clearSessions();
    const docOut = '/mnt/docs/report.pdf\t10\t1700000000\0';
    const { exec: exec2, calls: calls2 } = mockExec({
      find: ok(docOut),
      sha256sum: argv => ok(`${'c'.repeat(64)}  ${argv[1]}\n`),
    });
    const scan2 = await scanDevice({ exec: exec2, device: '/dev/sda1', catalogPath: ':memory:' });

    const result = await applyImportPlan({ exec: exec2, sessionId: scan2.sessionId, shareGid: 1024 });

    // The pdf was copied + chowned to the share gid.
    expect(calls2.some(c => c[0] === 'rsync')).toBe(true);
    expect(calls2.some(c => c[0] === 'chown' && c[1] === ':1024')).toBe(true);
    expect(result.applied).toBe(1);

    // Session is one-shot: a second apply with the same id is refused.
    await expect(
      applyImportPlan({ exec: exec2, sessionId: scan2.sessionId, shareGid: 1024 }),
    ).rejects.toThrow(/no reviewed plan/);

    // (scan from the first disk is unrelated — keeps the lint happy.)
    expect(scan.sessionId).not.toBe(scan2.sessionId);
  });
});
