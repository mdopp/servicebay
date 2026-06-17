import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

// Mock DATA_DIR to a process-scoped tmpdir so the durable session store
// (#1896) writes to a real fs path without colliding with the dev box.
vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-diskimport-svc-${process.pid}`),
}));

import {
  listImportDevices,
  scanDevice,
  startScan,
  startApply,
  getImportJob,
  applyImportPlan,
  __clearSessions,
} from './service';
import type { SafeExec, SafeExecResult } from './hostExec';

/** Spin the event loop until `cond()` is true or we give up. The background
 *  scan/apply tasks are detached promises; this lets a test await their
 *  completion without a real timer. */
async function waitFor(cond: () => Promise<boolean> | boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await new Promise(r => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

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

beforeEach(async () => {
  await __clearSessions();
});

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

describe('startScan / getImportJob — async hand-off + live status (#1897)', () => {
  it('returns a jobId immediately and the job walks scanning → reviewed with progress + review', async () => {
    const { exec } = mockExec({ find: ok(FIND_OUT) });
    const { jobId } = await startScan({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    // Hand-off is immediate — a job exists and is pollable right away.
    expect(jobId).toBeTruthy();
    const first = await getImportJob(jobId);
    expect(first).not.toBeNull();
    expect(['scanning', 'reviewed']).toContain(first!.phase);

    // The background scan finishes → phase=reviewed, with the review payload a
    // re-attaching card renders (this is the re-attach-by-id path).
    await waitFor(async () => (await getImportJob(jobId))!.phase === 'reviewed');
    const done = await getImportJob(jobId);
    expect(done!.phase).toBe('reviewed');
    expect(done!.review).toBeDefined();
    expect(done!.review!.totalFiles).toBe(3);
    expect(done!.progress.step).toBe('done');
    expect(done!.progress.scanned).toBe(3);
  });

  it('records a scan failure on the job (phase=error) instead of throwing into the void', async () => {
    // find exits non-zero with NO stdout → scanMount throws → recorded on the job.
    const { exec } = mockExec({ find: { stdout: '', stderr: 'boom', code: 2 } });
    const { jobId } = await startScan({ exec, device: '/dev/sda1', catalogPath: ':memory:' });
    await waitFor(async () => (await getImportJob(jobId))!.phase === 'error');
    const failed = await getImportJob(jobId);
    expect(failed!.phase).toBe('error');
    expect(failed!.error).toMatch(/scan walk failed/);
  });

  it('getImportJob returns null for an unknown/forged id', async () => {
    expect(await getImportJob('nope')).toBeNull();
  });
});

describe('startApply — async hand-off, gate checked synchronously (#1897)', () => {
  it('rejects a forged id synchronously (no background job, no host write)', async () => {
    const { exec, calls } = mockExec();
    await expect(
      startApply({ exec, sessionId: 'forged', shareGid: 1024 }),
    ).rejects.toThrow(/no reviewed plan/);
    expect(calls).toHaveLength(0);
  });

  it('returns a jobId, applies in the background, and the job reaches applied with a count', async () => {
    const docOut = '/mnt/docs/report.pdf\t10\t1700000000\0';
    const { exec, calls } = mockExec({
      find: ok(docOut),
      sha256sum: argv => ok(`${'c'.repeat(64)}  ${argv[1]}\n`),
    });
    // Scan synchronously so we have a reviewed session to apply.
    const scan = await scanDevice({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    const { jobId } = await startApply({ exec, sessionId: scan.sessionId, shareGid: 1024 });
    expect(jobId).toBe(scan.sessionId);

    await waitFor(async () => (await getImportJob(jobId))!.phase === 'applied');
    const done = await getImportJob(jobId);
    expect(done!.phase).toBe('applied');
    expect(done!.applied).toBe(1);
    expect(calls.some(c => c[0] === 'rsync')).toBe(true);

    // One apply per review: a second startApply is refused (phase is now applied).
    await expect(
      startApply({ exec, sessionId: scan.sessionId, shareGid: 1024 }),
    ).rejects.toThrow(/no reviewed plan/);
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
    const { exec } = mockExec({ find: ok(FIND_OUT) });
    const scan = await scanDevice({ exec, device: '/dev/sda1', catalogPath: ':memory:' });

    // No immich config wired → photos throw on apply; use a residue-only disk to
    // prove the copy path runs. Re-scan a docs-only listing.
    await __clearSessions();
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
