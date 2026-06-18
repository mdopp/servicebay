import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SafeExec } from '@servicebay/disk-import-worker';

// service.ts is a thin facade over apply/launcher/runStore — mock all three so
// these tests assert the FACADE's wiring (teardown-on-apply-success #1982), not
// the collaborators (each has its own unit tests).
vi.mock('./apply', () => ({ applyImport: vi.fn() }));
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

import { applyRun } from './service';
import { applyImport } from './apply';
import { cleanupRunMount } from './launcher';
import { getActiveRun, clearActiveRun } from './runStore';

const exec = (() => undefined) as unknown as SafeExec;
const RUN = { runId: 'r1', outDir: '/o', container: 'c', device: '/dev/sdb1', mountpoint: '/run/servicebay/disk-import/sdb1' };

describe('applyRun teardown (#1982)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unmounts the device and clears the run after a successful apply', async () => {
    vi.mocked(getActiveRun).mockResolvedValue(RUN as never);
    vi.mocked(applyImport).mockResolvedValue({ copied: 3 } as never);

    const result = await applyRun(exec, 1000);

    expect(result).toEqual({ copied: 3 });
    expect(cleanupRunMount).toHaveBeenCalledWith(exec, RUN);
    expect(clearActiveRun).toHaveBeenCalledOnce();
  });

  it('leaves the mount live (no cleanup) when the apply throws', async () => {
    vi.mocked(getActiveRun).mockResolvedValue(RUN as never);
    vi.mocked(applyImport).mockRejectedValue(new Error('apply boom'));

    await expect(applyRun(exec, 1000)).rejects.toThrow('apply boom');
    expect(cleanupRunMount).not.toHaveBeenCalled();
    expect(clearActiveRun).not.toHaveBeenCalled();
  });

  it('throws when there is no active run, without touching cleanup', async () => {
    vi.mocked(getActiveRun).mockResolvedValue(null as never);

    await expect(applyRun(exec, 1000)).rejects.toThrow('no active run');
    expect(applyImport).not.toHaveBeenCalled();
    expect(cleanupRunMount).not.toHaveBeenCalled();
  });
});
