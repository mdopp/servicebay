import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SafeExec } from '@servicebay/disk-import-worker';

// service.ts is a thin facade over apply/launcher/runStore — mock all three so
// these tests assert the FACADE's wiring (teardown-on-apply-success #1982), not
// the collaborators (each has its own unit tests).
vi.mock('./apply', () => ({
  applyImport: vi.fn(),
  replanImport: vi.fn(),
  triggerScan: vi.fn(),
  waitForReplanDone: vi.fn(async () => undefined),
  recordRunError: vi.fn(async () => undefined),
}));
vi.mock('./launcher', () => ({
  launchWorker: vi.fn(),
  readStatus: vi.fn(),
  isWorkerRunning: vi.fn(),
  stopWorker: vi.fn(),
  cleanupRunMount: vi.fn(async () => undefined),
  ensureWorkerImage: vi.fn(),
}));
vi.mock('./devices', () => ({ listImportDevices: vi.fn() }));
vi.mock('./runStore', () => ({
  setActiveRun: vi.fn(),
  getActiveRun: vi.fn(),
  clearActiveRun: vi.fn(async () => undefined),
}));

import { startApplyFlow, runApplyFlow, resolveShareGid } from './service';
import { applyImport, replanImport, waitForReplanDone, recordRunError } from './apply';
import { cleanupRunMount } from './launcher';
import { getActiveRun, clearActiveRun } from './runStore';

/** A SafeExec that reports the file-share data dir is owned by `gid`. */
function statExec(gid: number): SafeExec {
  return (async () => ({ stdout: `${gid}\n`, stderr: '', code: 0 })) as unknown as SafeExec;
}
const exec = statExec(973);
const RUN = { runId: 'r1', outDir: '/o', container: 'c', device: '/dev/sdb1', mountpoint: '/run/servicebay/disk-import/sdb1' };

describe('runApplyFlow teardown (#1982) + async flow (#2009)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unmounts the device and clears the run after a successful apply', async () => {
    vi.mocked(applyImport).mockResolvedValue({ copied: 3 } as never);

    const result = await runApplyFlow(exec, 1000, RUN as never, null);

    expect(result).toEqual({ copied: 3 });
    // The apply runs against the REAL host-resolved file-share gid (973), NOT the
    // 1000 fallback the route passed in.
    expect(vi.mocked(applyImport).mock.calls[0]![0]).toMatchObject({ shareGid: 973 });
    expect(cleanupRunMount).toHaveBeenCalledWith(exec, RUN);
    expect(clearActiveRun).toHaveBeenCalledOnce();
    // No rules → no re-plan wait.
    expect(waitForReplanDone).not.toHaveBeenCalled();
  });

  it('waits for the detached re-plan before applying when one was launched', async () => {
    vi.mocked(applyImport).mockResolvedValue({ copied: 1 } as never);

    await runApplyFlow(exec, 1000, RUN as never, 1234);

    // preUpdatedAt threaded through so the wait can spot the NEW done.
    expect(waitForReplanDone).toHaveBeenCalledWith({ runId: RUN.runId, preUpdatedAt: 1234 });
    expect(applyImport).toHaveBeenCalledOnce();
  });

  it('records an error and leaves the mount live (no cleanup) when the apply throws', async () => {
    vi.mocked(applyImport).mockRejectedValue(new Error('apply boom'));

    // The route already returned (#2009), so the flow swallows + records, never throws.
    const result = await runApplyFlow(exec, 1000, RUN as never, null);

    expect(result).toBeNull();
    expect(recordRunError).toHaveBeenCalledWith(RUN.runId, 'apply boom');
    expect(cleanupRunMount).not.toHaveBeenCalled();
    expect(clearActiveRun).not.toHaveBeenCalled();
  });
});

describe('startApplyFlow pre-flight (#2009)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws promptly when there is no active run, without touching apply/re-plan', async () => {
    vi.mocked(getActiveRun).mockResolvedValue(null as never);

    await expect(startApplyFlow(exec, 1000)).rejects.toThrow('no active run');
    expect(applyImport).not.toHaveBeenCalled();
    expect(replanImport).not.toHaveBeenCalled();
  });

  it('launches the detached re-plan synchronously when rules are passed', async () => {
    vi.mocked(getActiveRun).mockResolvedValue(RUN as never);
    vi.mocked(replanImport).mockResolvedValue(42 as never);
    vi.mocked(applyImport).mockResolvedValue({ copied: 0 } as never);

    await startApplyFlow(exec, 1000, { explicit: { docs: { owner: 'mdopp' } } } as never);

    // The re-plan launch happens before the route returns (preUpdatedAt captured).
    expect(replanImport).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN.runId, container: RUN.container }),
    );
    // The heavy continuation is fire-and-forget — let its microtasks settle.
    await new Promise(r => setImmediate(r));
    expect(waitForReplanDone).toHaveBeenCalledWith({ runId: RUN.runId, preUpdatedAt: 42 });
  });
});

describe('resolveShareGid — real file-share group, not the 1024 fallback', () => {
  it('stats the file-share data dir and returns its actual gid (973), not the fallback', async () => {
    const calls: string[][] = [];
    const exec973: SafeExec = (async (argv: string[]) => {
      calls.push(argv);
      return { stdout: '973\n', stderr: '', code: 0 };
    }) as unknown as SafeExec;

    const gid = await resolveShareGid(exec973, 1024);

    expect(gid).toBe(973);
    expect(gid).not.toBe(1024);
    // Resolved by `stat -c %g` on the file-share share root (host-side).
    expect(calls[0]).toEqual(['stat', '-c', '%g', '/mnt/data/stacks/file-share/data']);
  });

  it('falls back only when stat exits non-zero (share not deployed yet)', async () => {
    const execFail: SafeExec = (async () => ({ stdout: '', stderr: 'no such file', code: 1 })) as unknown as SafeExec;
    expect(await resolveShareGid(execFail, 1024)).toBe(1024);
  });

  it('falls back when stat emits a non-numeric gid', async () => {
    const execJunk: SafeExec = (async () => ({ stdout: 'nope\n', stderr: '', code: 0 })) as unknown as SafeExec;
    expect(await resolveShareGid(execJunk, 1024)).toBe(1024);
  });

  it('falls back when exec throws, never propagating', async () => {
    const execThrow: SafeExec = (async () => { throw new Error('agent down'); }) as unknown as SafeExec;
    expect(await resolveShareGid(execThrow, 1024)).toBe(1024);
  });
});
