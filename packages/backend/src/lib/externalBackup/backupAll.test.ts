import { describe, it, expect, vi, beforeEach } from 'vitest';

// The box "back up all" path launches the resource-capped backup worker (#1955)
// for every installed manifest service (the heavy walk/copy/tar runs in the worker
// container, not in this process — the in-process host-agent path OOM'd the box,
// #1894), then streams each produced tar to the NAS. Here we mock the worker
// service surface + the NAS client and assert the upload/skip behaviour; the worker
// launch/poll is covered by backupWorker/service.test.ts.
const { mockWorker, mockNas, mockCfg } = vi.hoisted(() => ({
  mockWorker: {
    runBackupForInstalled: vi.fn(),
    readBackupTar: vi.fn(),
    cleanupBackupRun: vi.fn(),
  },
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn(), nasRemove: vi.fn() },
  mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn() },
}));
vi.mock('../backupWorker/service', () => mockWorker);
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);

import { backupInstalledServicesToNas, NAS_BACKUP_DIR } from './producer';

const RUN = { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' };

function completed(results: Array<{ service: string; ok: boolean; outcome?: string; detail?: string | null }>) {
  return {
    exec: vi.fn(),
    run: RUN,
    status: {
      version: 1, runId: 'r', phase: 'done', step: 'done', total: results.length, processed: results.length,
      results: results.map(r => ({
        service: r.service, ok: r.ok, tarName: r.ok ? `${r.service}.tar` : null,
        bytes: 0, files: 0, outcome: r.outcome ?? (r.ok ? 'ok' : 'error'), detail: r.detail ?? null,
      })),
      error: null, updatedAt: 0, startedAt: 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCfg.getConfig.mockResolvedValue({});
  mockCfg.updateConfig.mockResolvedValue({});
  mockNas.nasUpload.mockResolvedValue(undefined);
  mockNas.nasList.mockResolvedValue([]); // prune lists then removes; empty NAS
  mockNas.nasRemove.mockResolvedValue(undefined);
  mockWorker.readBackupTar.mockResolvedValue(Buffer.from('tarbytes'));
  mockWorker.cleanupBackupRun.mockResolvedValue(undefined);
});

describe('backupInstalledServicesToNas', () => {
  it('uploads each ok tar as a dated NAS slot and cleans up the run', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(completed([{ service: 'adguard', ok: true }]));

    const results = await backupInstalledServicesToNas();

    expect(results.map(r => r.service)).toEqual(['adguard']);
    expect(results[0]).toMatchObject({ service: 'adguard', ok: true });
    expect(results[0].tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/); // dated slot (#1865)
    const uploaded = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploaded.some(p => new RegExp(`${NAS_BACKUP_DIR}/adguard-\\d{8}-\\d{4}\\.tar$`).test(p))).toBe(true);
    expect(mockWorker.cleanupBackupRun).toHaveBeenCalledTimes(1);
  });

  it('records a worker skip/error as a per-service failure without uploading it', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(
      completed([
        { service: 'adguard', ok: false, outcome: 'skip', detail: 'No config files to back up' },
        { service: 'nginx', ok: true },
      ]),
    );

    const results = await backupInstalledServicesToNas();
    expect(results.find(r => r.service === 'adguard')).toMatchObject({ ok: false });
    expect(results.find(r => r.service === 'nginx')).toMatchObject({ ok: true });
    // Only the ok service was uploaded (1 tar + 1 meta).
    expect(mockNas.nasUpload).toHaveBeenCalledTimes(2);
  });

  it('returns empty when nothing with a manifest is installed (no launch)', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(null);
    expect(await backupInstalledServicesToNas()).toEqual([]);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });
});

// #2615 — before this, the ONLY trace of a nightly run was one journal line, so
// a healthy push and a mechanism that had stopped a year ago looked identical
// from outside. The run now records its own outcome, denominator included.
describe('backupInstalledServicesToNas — recording the run outcome (#2615)', () => {
  const recorded = () => mockCfg.updateConfig.mock.calls.at(-1)?.[0]?.externalBackup;

  it('records a full run as success with the ok/total tally', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(
      completed([{ service: 'adguard', ok: true }, { service: 'nginx', ok: true }]),
    );
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ lastStatus: 'success', servicesOk: 2, servicesTotal: 2 });
    expect(recorded().lastRun).toEqual(expect.any(String));
  });

  it('records a mixed run as partial, naming what was NOT backed up', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(
      completed([
        { service: 'adguard', ok: false, outcome: 'skip', detail: 'No config files to back up' },
        { service: 'nginx', ok: true },
      ]),
    );
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ lastStatus: 'partial', servicesOk: 1, servicesTotal: 2 });
    expect(recorded().lastMessage).toMatch(/adguard/);
  });

  it('records a 0/0 run rather than leaving it indistinguishable from never-ran', async () => {
    mockWorker.runBackupForInstalled.mockResolvedValue(null);
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ servicesOk: 0, servicesTotal: 0 });
  });

  it('records a thrown run as an error and still rethrows', async () => {
    mockWorker.runBackupForInstalled.mockRejectedValue(new Error('worker never came up'));
    await expect(backupInstalledServicesToNas()).rejects.toThrow('worker never came up');
    expect(recorded()).toMatchObject({ lastStatus: 'error', lastMessage: 'worker never came up' });
  });

  it('never turns a completed backup into a failure when the config write fails', async () => {
    mockCfg.updateConfig.mockRejectedValue(new Error('config is read-only'));
    mockWorker.runBackupForInstalled.mockResolvedValue(completed([{ service: 'adguard', ok: true }]));
    const results = await backupInstalledServicesToNas();
    expect(results).toMatchObject([{ service: 'adguard', ok: true }]);
  });

  it('preserves the existing externalBackup settings it writes alongside', async () => {
    mockCfg.getConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '04:15', retention: 3 } });
    mockWorker.runBackupForInstalled.mockResolvedValue(completed([{ service: 'adguard', ok: true }]));
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ enabled: true, time: '04:15', retention: 3 });
  });
});
