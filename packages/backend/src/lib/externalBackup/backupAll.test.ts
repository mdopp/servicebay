import { describe, it, expect, vi, beforeEach } from 'vitest';

// The box "back up all" path launches the resource-capped backup worker (#1955)
// for every installed manifest service (the heavy walk/copy/tar runs in the worker
// container, not in this process — the in-process host-agent path OOM'd the box,
// #1894), then streams each produced tar to the NAS. Here we mock the worker
// service surface + the NAS client and assert the upload/skip behaviour; the worker
// launch/poll is covered by backupWorker/service.test.ts.
const { mockWorker, mockNas, mockCfg, mockDecl } = vi.hoisted(() => ({
  mockWorker: {
    runBackupForServices: vi.fn(),
    runBackupForInstalled: vi.fn(),
    readBackupTar: vi.fn(),
    cleanupBackupRun: vi.fn(),
  },
  mockNas: {
    nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn(), nasRemove: vi.fn(),
    // Spied, so a test can assert the whole upload phase runs inside ONE
    // destination session (#2876) rather than a connection per call.
    withNasSession: vi.fn(<T,>(fn: () => Promise<T>): Promise<T> => fn()),
  },
  mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn() },
  // The run resolves the installed DECLARATIONS itself now (#2950) — it is the
  // only way it can see a template that declares nothing, which used to leave
  // the list and take its own absence with it.
  mockDecl: {
    resolveInstalledBackupDeclarations: vi.fn(),
    resolveServiceBackupManifest: vi.fn(),
    resolveInstalledBackupManifests: vi.fn(),
    resolveTemplateManifests: vi.fn(),
  },
}));
vi.mock('../backupWorker/service', () => mockWorker);
vi.mock('./templateManifests', () => mockDecl);
// The connection-error classifier stays REAL: the run's recorded message is what
// the `config_backup` probe groups on, so a stub here would let the two drift.
vi.mock('./nasClient', async () => ({
  ...mockNas,
  isConnectionLevelError: (await vi.importActual<typeof import('./nasClient')>('./nasClient'))
    .isConnectionLevelError,
}));
vi.mock('../config', () => mockCfg);

import { backupInstalledServicesToNas, NAS_BACKUP_DIR } from './producer';

const RUN = { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' };

function completed(
  results: Array<{ service: string; ok: boolean; outcome?: string; detail?: string | null; skipped?: string[] }>,
  inconsistent?: Set<string>,
) {
  return {
    exec: vi.fn(),
    run: RUN,
    status: {
      version: 1, runId: 'r', phase: 'done', step: 'done', total: results.length, processed: results.length,
      results: results.map(r => ({
        service: r.service, ok: r.ok, tarName: r.ok ? `${r.service}.tar` : null,
        bytes: 0, files: 0, outcome: r.outcome ?? (r.ok ? 'ok' : 'error'), detail: r.detail ?? null,
        ...(r.skipped ? { skipped: r.skipped } : {}),
      })),
      error: null, updatedAt: 0, startedAt: 0,
    },
    inconsistent,
  };
}

/**
 * Arm one run: `results` are the services whose declaration resolved (the
 * worker returns these), `unresolved` the installed templates whose declaration
 * the run could NOT use, and `optedOut` the deliberate `backup: none` ones.
 */
function armRun(
  results: Parameters<typeof completed>[0],
  opts: {
    inconsistent?: Set<string>;
    unresolved?: { template: string; reason: string }[];
    optedOut?: { template: string; reason: string }[];
  } = {},
): void {
  mockDecl.resolveInstalledBackupDeclarations.mockResolvedValue({
    manifests: results.map(r => ({ service: r.service, include: ['config'], exclude: [] })),
    unresolved: opts.unresolved ?? [],
    optedOut: opts.optedOut ?? [],
  });
  mockWorker.runBackupForServices.mockResolvedValue(completed(results, opts.inconsistent));
}

beforeEach(() => {
  vi.clearAllMocks();
  armRun([]);
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
    armRun([{ service: 'adguard', ok: true }]);

    const results = await backupInstalledServicesToNas();

    expect(results.map(r => r.service)).toEqual(['adguard']);
    expect(results[0]).toMatchObject({ service: 'adguard', ok: true });
    expect(results[0].tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/); // dated slot (#1865)
    const uploaded = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploaded.some(p => new RegExp(`${NAS_BACKUP_DIR}/adguard-\\d{8}-\\d{4}\\.tar$`).test(p))).toBe(true);
    expect(mockWorker.cleanupBackupRun).toHaveBeenCalledTimes(1);
  });

  it('records a worker skip/error as a per-service failure without uploading it', async () => {
    armRun([
      { service: 'adguard', ok: false, outcome: 'skip', detail: 'No config files to back up' },
      { service: 'nginx', ok: true },
    ]);

    const results = await backupInstalledServicesToNas();
    expect(results.find(r => r.service === 'adguard')).toMatchObject({ ok: false });
    expect(results.find(r => r.service === 'nginx')).toMatchObject({ ok: true });
    // Only the ok service was uploaded (1 tar + 1 meta).
    expect(mockNas.nasUpload).toHaveBeenCalledTimes(2);
  });

  it('returns empty when nothing with a manifest is installed (no launch)', async () => {
    armRun([]);
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
    armRun([{ service: 'adguard', ok: true }, { service: 'nginx', ok: true }]);
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ lastStatus: 'success', servicesOk: 2, servicesTotal: 2 });
    expect(recorded().lastRun).toEqual(expect.any(String));
  });

  it('records a mixed run as partial, naming what was NOT backed up', async () => {
    armRun([
        { service: 'adguard', ok: false, outcome: 'skip', detail: 'No config files to back up' },
        { service: 'nginx', ok: true },
      ]);
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ lastStatus: 'partial', servicesOk: 1, servicesTotal: 2 });
    expect(recorded().lastMessage).toMatch(/adguard/);
  });

  it('records a 0/0 run rather than leaving it indistinguishable from never-ran', async () => {
    armRun([]);
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ servicesOk: 0, servicesTotal: 0 });
  });

  it('records a thrown run as an error and still rethrows', async () => {
    armRun([{ service: 'adguard', ok: true }]);
    mockWorker.runBackupForServices.mockRejectedValue(new Error('worker never came up'));
    await expect(backupInstalledServicesToNas()).rejects.toThrow('worker never came up');
    expect(recorded()).toMatchObject({ lastStatus: 'error', lastMessage: 'worker never came up' });
  });

  it('never turns a completed backup into a failure when the config write fails', async () => {
    mockCfg.updateConfig.mockRejectedValue(new Error('config is read-only'));
    armRun([{ service: 'adguard', ok: true }]);
    const results = await backupInstalledServicesToNas();
    expect(results).toMatchObject([{ service: 'adguard', ok: true }]);
  });

  it('preserves the existing externalBackup settings it writes alongside', async () => {
    mockCfg.getConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '04:15', retention: 3 } });
    armRun([{ service: 'adguard', ok: true }]);
    await backupInstalledServicesToNas();
    expect(recorded()).toMatchObject({ enabled: true, time: '04:15', retention: 3 });
  });
});

// #2876 / #2877 — the two ways a run used to lose services for reasons that had
// nothing to do with the service: 50–70 FTP sessions in ~10 s, and a snapshot the
// backup worker could not read back.
describe('backupInstalledServicesToNas — one destination session, honest meta', () => {
  const recorded = () => mockCfg.updateConfig.mock.calls.at(-1)?.[0]?.externalBackup;
  const uploadedMeta = (): Record<string, unknown> => {
    const call = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('.meta.json'))!;
    return JSON.parse(String(call[1])) as Record<string, unknown>;
  };

  it('runs the whole upload phase inside ONE destination session (#2876)', async () => {
    armRun([{ service: 'adguard', ok: true }, { service: 'nginx', ok: true }]);
    await backupInstalledServicesToNas();
    // One session for the run — not one per service, and not one per call.
    expect(mockNas.withNasSession).toHaveBeenCalledTimes(1);
  });

  it('records the run message with the connection drop grouped, not per service (#2876)', async () => {
    armRun([
        { service: 'adguard', ok: true },
        { service: 'paperless', ok: false, detail: 'connect ECONNREFUSED 192.168.178.1:21 (control socket)' },
        { service: 'beets', ok: false, detail: 'connect ECONNREFUSED 192.168.178.1:21 (control socket)' },
      ]);
    await backupInstalledServicesToNas();
    expect(recorded().lastMessage).toMatch(/dropped the connection after 1 of 3 services/);
    expect(recorded().lastMessage).toContain('paperless, beets');
  });

  it('marks a live (inconsistent) collector copy in the tar meta (#2877)', async () => {
    armRun([{ service: 'nginx', ok: true }], { inconsistent: new Set(['nginx']) });
    await backupInstalledServicesToNas();
    expect(uploadedMeta()).toMatchObject({ service: 'nginx', consistent: false });
  });

  it('leaves `consistent` absent when the snapshot was torn-free', async () => {
    armRun([{ service: 'nginx', ok: true }]);
    await backupInstalledServicesToNas();
    expect(uploadedMeta()).not.toHaveProperty('consistent');
  });

  it('records the files a landed tar shipped WITHOUT, in the meta and the run (#2877)', async () => {
    // nginx's tar reaches the NAS but has no database.sqlite: the file is
    // root-owned 0600 and no collector snapshot was taken. The run must not read
    // as a clean success — the restore, and the operator, have to be told.
    armRun([{ service: 'nginx', ok: true, skipped: ['data/database.sqlite'] }]);
    const results = await backupInstalledServicesToNas();

    expect(results[0]).toMatchObject({ service: 'nginx', ok: true, skipped: ['data/database.sqlite'] });
    expect(uploadedMeta()).toMatchObject({ service: 'nginx', skippedFiles: ['data/database.sqlite'] });
    expect(recorded()).toMatchObject({
      lastStatus: 'partial',
      servicesOk: 1,
      servicesTotal: 1,
      servicesIncomplete: ['nginx'],
    });
    expect(recorded().lastMessage).toMatch(/WITHOUT some declared files: nginx \(data\/database\.sqlite\)/);
  });

  it('leaves `skippedFiles` absent and the run a success when every file made it', async () => {
    armRun([{ service: 'nginx', ok: true }]);
    await backupInstalledServicesToNas();
    expect(uploadedMeta()).not.toHaveProperty('skippedFiles');
    expect(recorded()).toMatchObject({ lastStatus: 'success', servicesIncomplete: [] });
  });
});
