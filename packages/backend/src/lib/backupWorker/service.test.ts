import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLauncher, mockCfg, mockCollector, mockExecutor } = vi.hoisted(() => ({
  mockLauncher: {
    launchBackupWorker: vi.fn(),
    readBackupStatus: vi.fn(),
    isBackupWorkerRunning: vi.fn(),
    stopBackupWorker: vi.fn(),
    ensureBackupWorkerImage: vi.fn(),
    readBackupTar: vi.fn(),
  },
  mockCfg: { getConfig: vi.fn() },
  mockCollector: { runBackupCollector: vi.fn() },
  mockExecutor: vi.fn(async (argv: string[], opts?: unknown) => { void argv; void opts; return { stdout: '', stderr: '', code: 0 }; }),
}));

vi.mock('./launcher', () => mockLauncher);
vi.mock('@/lib/config', () => ({ getConfig: () => mockCfg.getConfig() }));
vi.mock('@/lib/dirs', () => ({ HOST_DATA_DIR: '/mnt/data/servicebay' }));
vi.mock('@/lib/agent/executor', () => ({
  AgentExecutor: class { execSafe = (argv: string[], opts?: unknown) => mockExecutor(argv, opts); },
}));
vi.mock('../externalBackup/collector', () => mockCollector);

import {
  runBackupForServices,
  runBackupForInstalled,
  stageInstalledServiceConfigViaWorker,
} from './service';

const RUN = { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' };

function doneStatus(results: Array<{ service: string; ok: boolean; outcome?: string; detail?: string | null }>) {
  return {
    version: 1, runId: 'r', phase: 'done' as const, step: 'done', total: results.length, processed: results.length,
    results: results.map(r => ({
      service: r.service, ok: r.ok, tarName: r.ok ? `${r.service}.tar` : null,
      bytes: 0, files: 0, outcome: r.outcome ?? (r.ok ? 'ok' : 'error'), detail: r.detail ?? null,
    })),
    error: null, updatedAt: 0, startedAt: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCfg.getConfig.mockResolvedValue({
    installedTemplates: { adguard: {}, 'home-assistant': {} },
    templateSettings: { DATA_DIR: '/mnt/data/stacks' },
  });
  mockLauncher.launchBackupWorker.mockResolvedValue(RUN);
  mockLauncher.ensureBackupWorkerImage.mockResolvedValue(undefined);
  mockLauncher.isBackupWorkerRunning.mockResolvedValue(true);
  mockCollector.runBackupCollector.mockResolvedValue({});
});

describe('runBackupForServices', () => {
  it('runs collectors, launches one worker over the stacks dir, and returns the completed run', async () => {
    mockLauncher.readBackupStatus.mockResolvedValue(doneStatus([{ service: 'nginx', ok: true }]));

    const completed = await runBackupForServices(['nginx']);

    // nginx declares an npm-sqlite collector → run host-side before launch.
    expect(mockCollector.runBackupCollector).toHaveBeenCalledWith(expect.objectContaining({ service: 'nginx' }), 'Local');
    expect(mockLauncher.launchBackupWorker).toHaveBeenCalledTimes(1);
    const arg = mockLauncher.launchBackupWorker.mock.calls[0][0];
    expect(arg.services).toEqual(['nginx']);
    expect(arg.stacksDir).toBe('/mnt/data/stacks');
    expect(arg.dataDir).toBe('/mnt/data/servicebay');
    expect(completed.run).toEqual(RUN);
    expect(completed.status.results).toHaveLength(1);
  });

  it('throws (and cleans up) when the run ends in error', async () => {
    mockLauncher.readBackupStatus.mockResolvedValue({ ...doneStatus([]), phase: 'error', error: 'boom' });
    await expect(runBackupForServices(['adguard'])).rejects.toThrow(/boom/);
    // cleanup removed the out dir
    expect(mockExecutor).toHaveBeenCalledWith(['rm', '-rf', RUN.outDir], expect.anything());
  });

  it('throws when the worker vanishes without a terminal status', async () => {
    mockLauncher.readBackupStatus.mockResolvedValue(null);
    mockLauncher.isBackupWorkerRunning.mockResolvedValue(false);
    await expect(runBackupForServices(['adguard'])).rejects.toThrow(/without writing a terminal status/);
  });
});

describe('runBackupForInstalled', () => {
  it('selects installed manifest services incl. the zwave sibling and launches once', async () => {
    mockLauncher.readBackupStatus.mockResolvedValue(
      doneStatus([{ service: 'adguard', ok: true }, { service: 'home-assistant', ok: true }, { service: 'home-assistant-zwave', ok: true }]),
    );
    const completed = await runBackupForInstalled();
    expect(completed).not.toBeNull();
    const arg = mockLauncher.launchBackupWorker.mock.calls[0][0];
    // home-assistant-zwave gates on home-assistant (installed) and rides along.
    expect(arg.services).toEqual(expect.arrayContaining(['adguard', 'home-assistant', 'home-assistant-zwave']));
  });

  it('returns null (no launch) when nothing with a manifest is installed', async () => {
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: { 'unmanaged-thing': {} } });
    expect(await runBackupForInstalled()).toBeNull();
    expect(mockLauncher.launchBackupWorker).not.toHaveBeenCalled();
  });
});

describe('stageInstalledServiceConfigViaWorker', () => {
  it('is the installed-run handle for the caller to consume', async () => {
    mockLauncher.readBackupStatus.mockResolvedValue(doneStatus([{ service: 'adguard', ok: true }]));
    const staged = await stageInstalledServiceConfigViaWorker();
    expect(staged).not.toBeNull();
    expect(staged!.run).toEqual(RUN);
  });

  it('returns null when nothing is installed', async () => {
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: {} });
    expect(await stageInstalledServiceConfigViaWorker()).toBeNull();
  });
});
