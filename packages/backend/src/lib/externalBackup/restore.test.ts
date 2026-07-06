import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockCfg, mockNpmCredStatus, mockRekeyNpm, mockGetExecutor } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn(), saveConfig: vi.fn() },
  mockNpmCredStatus: vi.fn(),
  mockRekeyNpm: vi.fn(),
  mockGetExecutor: vi.fn(),
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);
vi.mock('../reverseProxy/npmAdminRekey', () => ({
  npmAdminCredStatus: (...a: unknown[]) => mockNpmCredStatus(...a),
  rekeyNpmAdmin: (...a: unknown[]) => mockRekeyNpm(...a),
}));
vi.mock('../executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));

import { restoreServiceBackup, isFreshDataDir, autoRestoreServiceOnReinstall, wipeServiceForReinstall } from './restore';
import { NAS_BACKUP_DIR } from './producer';

let tmpRoot: string;
let dataDir: string;

/** Build a plain service tar like the producer writes: manifest files at root. */
async function buildServiceTar(files: Record<string, string>): Promise<Buffer> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-stage-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(stage, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  const tarPath = path.join(stage, 'out.tar');
  await execFileAsync('tar', ['-cf', tarPath, '-C', stage, '.']);
  const buf = await fs.readFile(tarPath);
  await fs.rm(stage, { recursive: true, force: true });
  return buf;
}

/** Mock nasDownload to serve `tar` for home-assistant.tar, 404 the sidecar. */
function serveTar(tar: Buffer) {
  mockNas.nasDownload.mockImplementation(async (p: string) => {
    if (p === `${NAS_BACKUP_DIR}/home-assistant.tar`) return tar;
    throw new Error('not found'); // no meta sidecar — restore still works
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-test-'));
  mockCfg.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: tmpRoot } });
  mockCfg.saveConfig.mockResolvedValue(undefined);
  // #1865 — restore now resolves the latest snapshot from the listing. Default
  // to advertising the bare legacy slot (a valid undated snapshot) so the
  // existing backward-compat restore tests resolve it; tests asserting dated
  // snapshot selection override this.
  mockNas.nasList.mockResolvedValue([{ name: 'home-assistant.tar', size: 1024 }]);
  // HA config lives one level down under home-assistant/homeassistant/ (the
  // container's /config) — the manifest dataSubdir (#1597). Restore extracts
  // the producer's bare-rooted tar into exactly this dir.
  dataDir = path.join(tmpRoot, 'home-assistant', 'homeassistant');
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('restoreServiceBackup', () => {
  it('extracts the NAS tar into a fresh service data dir', async () => {
    serveTar(await buildServiceTar({
      'configuration.yaml': 'default_config:',
      '.storage/zwave_js': '{"keys":"MESH"}',
    }));

    const res = await restoreServiceBackup('home-assistant', { local: true });
    expect(res.service).toBe('home-assistant');
    expect(res.dataDir).toBe(dataDir);
    expect(res.files).toBe(2);
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('default_config:');
    expect(await fs.readFile(path.join(dataDir, '.storage/zwave_js'), 'utf8')).toBe('{"keys":"MESH"}');
  });

  it('refuses a non-empty data dir without force (never clobbers a live service)', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'existing.yaml'), 'live');
    serveTar(await buildServiceTar({ 'configuration.yaml': 'incoming' }));

    await expect(restoreServiceBackup('home-assistant', { local: true })).rejects.toThrow(/already has data/);
    expect(await fs.readFile(path.join(dataDir, 'existing.yaml'), 'utf8')).toBe('live'); // untouched
  });

  it('overwrites a populated data dir when force is set', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'old');
    serveTar(await buildServiceTar({ 'configuration.yaml': 'new' }));

    const res = await restoreServiceBackup('home-assistant', { force: true, local: true });
    expect(res.files).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('new');
  });

  it('rejects a service with no backup manifest', async () => {
    await expect(restoreServiceBackup('not-a-service')).rejects.toThrow(/No backup manifest/);
  });

  it('defaults to the MOST-RECENT dated snapshot when no tarName is given (#1865)', async () => {
    // Two dated snapshots on the NAS — the newer carries the good config, the
    // older the (later-corrupted) state. Default restore picks the newest.
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant-20260614-0530.tar', size: 50 },
      { name: 'home-assistant-20260615-0531.tar', size: 60 },
    ]);
    mockNas.nasDownload.mockImplementation(async (p: string) => {
      if (p === `${NAS_BACKUP_DIR}/home-assistant-20260615-0531.tar`) {
        return buildServiceTar({ 'configuration.yaml': 'latest:' });
      }
      throw new Error(`unexpected download ${p}`);
    });
    const res = await restoreServiceBackup('home-assistant', { local: true });
    expect(res.files).toBe(1);
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('latest:');
  });

  it('restores a SPECIFIC older snapshot when tarName is given — the recover-from-before-corruption path (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant-20260614-0530.tar', size: 50 }, // the good pre-corruption copy
      { name: 'home-assistant-20260615-0531.tar', size: 60 }, // the corrupted latest
    ]);
    mockNas.nasDownload.mockImplementation(async (p: string) => {
      if (p === `${NAS_BACKUP_DIR}/home-assistant-20260614-0530.tar`) {
        return buildServiceTar({ 'automations.yaml': '- alias: front door\n' });
      }
      throw new Error(`unexpected download ${p}`);
    });
    const res = await restoreServiceBackup('home-assistant', { local: true, tarName: 'home-assistant-20260614-0530.tar' });
    expect(res.files).toBe(1);
    expect(await fs.readFile(path.join(dataDir, 'automations.yaml'), 'utf8')).toBe('- alias: front door\n');
  });

  it('rejects a tarName that does not belong to the service (no cross-service restore) (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant-20260615-0531.tar', size: 60 },
      { name: 'adguard-20260615-0531.tar', size: 30 },
    ]);
    await expect(
      restoreServiceBackup('home-assistant', { local: true, tarName: 'adguard-20260615-0531.tar' }),
    ).rejects.toThrow(/No backup snapshot/);
  });

  it('errors clearly when the service has no snapshot on the NAS (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'adguard.tar', size: 30 }]);
    await expect(restoreServiceBackup('home-assistant', { local: true })).rejects.toThrow(/No config backup found/);
  });
});

describe('isFreshDataDir', () => {
  it('is true for absent or empty dirs, false once populated', async () => {
    expect(await isFreshDataDir(path.join(tmpRoot, 'absent'))).toBe(true);
    const empty = path.join(tmpRoot, 'empty');
    await fs.mkdir(empty);
    expect(await isFreshDataDir(empty)).toBe(true);
    await fs.writeFile(path.join(empty, 'f'), 'x');
    expect(await isFreshDataDir(empty)).toBe(false);
  });
});

describe('autoRestoreServiceOnReinstall (#1218 entry point 1)', () => {
  /** NAS has a home-assistant.tar; serve its contents on download. */
  function nasHasHomeAssistantBackup() {
    mockNas.nasList.mockResolvedValue([{ name: 'home-assistant.tar', size: 1024 }]);
    serveTar(buildServiceTarSync());
  }
  // buildServiceTar is async; pre-build once per test via a small wrapper.
  let _tar: Buffer;
  function buildServiceTarSync() { return _tar; }

  beforeEach(async () => {
    _tar = await buildServiceTar({ 'configuration.yaml': 'restored:', '.storage/zwave_js': '{"k":1}' });
  });

  it('restores on install into an empty data dir (Local node)', async () => {
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'install', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    expect(logs.some(l => l.includes('restored') && l.includes('home-assistant'))).toBe(true);
  });

  it('restores given backup-exists + empty dir even with no wipeMode set (#1584)', async () => {
    // #1520 retired cleanInstall to a hard-coded false; restore depends only on
    // backup-exists + fresh-dir for the plain install path.
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    expect(logs.some(l => l.includes('restored') && l.includes('home-assistant'))).toBe(true);
  });

  it('is a no-op on a remote node (restore primitive is local-fs only)', async () => {
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'install', node: 'edge-node' }, async l => { logs.push(l); });
    expect(await isFreshDataDir(dataDir)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('logs a visible skip breadcrumb (not silent) when no backup exists for the service', async () => {
    mockNas.nasList.mockResolvedValue([]); // empty NAS
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'install', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(logs.some(l => l.includes('home-assistant') && l.includes('no config backup'))).toBe(true);
    expect(logs.some(l => l.includes('restored'))).toBe(false);
  });

  it('on install, skips a non-empty data dir with a logged reason, never clobbers, never throws (#1584)', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'live.yaml'), 'live');
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await expect(
      autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'install', node: 'Local', local: true }, async l => { logs.push(l); }),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(dataDir, 'live.yaml'), 'utf8')).toBe('live'); // untouched
    expect(logs.some(l => l.includes('not empty') && l.includes('skipping restore'))).toBe(true);
    expect(logs.some(l => l.includes('restored'))).toBe(false);
  });

  it('on wipe-config, FORCE-restores config over a non-empty (kept-data) dir (#1585)', async () => {
    // Simulate post-wipe state: DATA kept, CONFIG cleared. The kept DATA file
    // must survive; CONFIG must be re-seeded from the NAS over the top.
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'KEPT-RECORDER-DB');
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'wipe-config', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    expect(await fs.readFile(path.join(dataDir, 'home-assistant_v2.db'), 'utf8')).toBe('KEPT-RECORDER-DB'); // DATA kept
    expect(logs.some(l => l.includes('wipe-config') && l.includes('restoring config'))).toBe(true);
  });

  it('on wipe-all, restores config into the (now-empty) dir (#1585)', async () => {
    nasHasHomeAssistantBackup();
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'wipe-all', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    expect(logs.some(l => l.includes('restored') && l.includes('home-assistant'))).toBe(true);
  });

  it('a failed restore is a LOUD warning + persists a diagnose finding, never a quiet note (#2161)', async () => {
    // A backup exists (so we attempt), but the download blows up mid-restore.
    mockNas.nasList.mockResolvedValue([{ name: 'home-assistant.tar', size: 1024 }]);
    mockNas.nasDownload.mockRejectedValue(new Error('NAS connection refused'));
    const logs: string[] = [];
    await expect(
      autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'wipe-all', node: 'Local', local: true }, async l => { logs.push(l); }),
    ).resolves.toBeUndefined(); // never blocks the deploy
    // Loud warning naming the service + the default-config consequence.
    expect(logs.some(l => l.includes('⚠️') && l.includes('home-assistant') && /FAILED/i.test(l) && /DEFAULT config/i.test(l))).toBe(true);
    // NOT demoted to a quiet (note).
    expect(logs.some(l => l.startsWith('(note) home-assistant: NAS config restore skipped'))).toBe(false);
    // Persistent diagnose finding recorded (saveConfig carries the restore failure).
    type SavedCfg = { installHandlerFailures?: Record<string, { message: string }> };
    const saved = mockCfg.saveConfig.mock.calls.map(c => c[0] as SavedCfg);
    const withFailure = saved.find(c => c?.installHandlerFailures?.['restore:home-assistant']);
    expect(withFailure).toBeTruthy();
    expect(withFailure!.installHandlerFailures!['restore:home-assistant'].message).toMatch(/NAS config restore failed/);
  });
});

describe('wipeServiceForReinstall (#1585)', () => {
  it('install mode is a no-op (keeps config + data, logs nothing)', async () => {
    await fs.mkdir(path.join(dataDir, '.storage'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'data');
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'install', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('cfg');
    expect(await fs.readFile(path.join(dataDir, 'home-assistant_v2.db'), 'utf8')).toBe('data');
    expect(logs).toEqual([]);
  });

  it('wipe-config clears CONFIG paths, KEEPS DATA paths (#1585 core)', async () => {
    await fs.mkdir(path.join(dataDir, '.storage'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    await fs.writeFile(path.join(dataDir, 'automations.yaml'), 'autos');
    await fs.writeFile(path.join(dataDir, '.storage/zwave_js'), 'keys'); // CONFIG (mesh keys)
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'RECORDER'); // DATA
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'wipe-config', node: 'Local', local: true }, async l => { logs.push(l); });
    // CONFIG gone:
    await expect(fs.access(path.join(dataDir, 'configuration.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, 'automations.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, '.storage/zwave_js'))).rejects.toThrow();
    // DATA kept:
    expect(await fs.readFile(path.join(dataDir, 'home-assistant_v2.db'), 'utf8')).toBe('RECORDER');
    expect(logs.some(l => l.includes('wipe-config') && l.includes('kept the service data'))).toBe(true);
  });

  it('wipe-all clears the entire service data dir (CONFIG + DATA)', async () => {
    await fs.mkdir(path.join(dataDir, '.storage'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'RECORDER');
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'wipe-all', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(await isFreshDataDir(dataDir)).toBe(true);
    expect(logs.some(l => l.includes('wipe-all') && l.includes('config + data'))).toBe(true);
  });

  it('is a no-op on a remote node', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'wipe-all', node: 'edge-node' }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('cfg'); // untouched
    expect(logs).toEqual([]);
  });

  it('logs a skip note for a service with no manifest (no classification to wipe)', async () => {
    const logs: string[] = [];
    await wipeServiceForReinstall('not-a-service', { wipeMode: 'wipe-config', node: 'Local', local: true }, async l => { logs.push(l); });
    expect(logs.some(l => l.includes('no backup manifest'))).toBe(true);
  });
});

describe('NPM credential reconcile after restore (#1529)', () => {
  /** Serve an nginx.tar (restored into tmpRoot/nginx-proxy-manager). The bare
   *  slot is a valid undated snapshot the latest-resolver finds (#1865). */
  async function serveNginxTar() {
    const tar = await buildServiceTar({ 'data/database.sqlite': 'RESTORED-DB' });
    mockNas.nasList.mockResolvedValue([{ name: 'nginx.tar', size: tar.length }]);
    mockNas.nasDownload.mockImplementation(async (p: string) => {
      if (p === `${NAS_BACKUP_DIR}/nginx.tar`) return tar;
      throw new Error('not found');
    });
  }

  it('re-keys SB to the restored DB when NPM rejects the stored credential', async () => {
    await serveNginxTar();
    mockNpmCredStatus.mockResolvedValue('rejected');
    mockRekeyNpm.mockResolvedValue({ ok: true, message: 'NPM admin password re-keyed and saved', email: 'a@x' });

    const res = await restoreServiceBackup('nginx', { local: true });
    expect(res.dataDir).toBe(path.join(tmpRoot, 'nginx-proxy-manager'));
    expect(mockRekeyNpm).toHaveBeenCalledWith('Local');
    expect(res.credentialReconcile).toEqual({ ok: true, message: expect.stringContaining('re-keyed') });
  });

  it('does not re-key when the stored credential still authenticates', async () => {
    await serveNginxTar();
    mockNpmCredStatus.mockResolvedValue('ok');

    const res = await restoreServiceBackup('nginx', { local: true });
    expect(mockRekeyNpm).not.toHaveBeenCalled();
    expect(res.credentialReconcile).toBeUndefined();
  });

  it('is a no-op when NPM is not reachable (e.g. pre-pod-start reinstall)', async () => {
    await serveNginxTar();
    mockNpmCredStatus.mockResolvedValue('unknown');

    const res = await restoreServiceBackup('nginx', { local: true });
    expect(mockRekeyNpm).not.toHaveBeenCalled();
    expect(res.credentialReconcile).toBeUndefined();
  });

  it('surfaces a failed re-key rather than masking it', async () => {
    await serveNginxTar();
    mockNpmCredStatus.mockResolvedValue('no-creds');
    mockRekeyNpm.mockResolvedValue({ ok: false, message: 'Could not find the running NPM container to re-key.' });

    const res = await restoreServiceBackup('nginx', { local: true });
    expect(res.credentialReconcile).toEqual({ ok: false, message: expect.stringContaining('Could not find') });
  });

  it('never reconciles for a non-NPM service', async () => {
    serveTar(await buildServiceTar({ 'configuration.yaml': 'x' }));
    const res = await restoreServiceBackup('home-assistant', { local: true });
    expect(mockNpmCredStatus).not.toHaveBeenCalled();
    expect(res.credentialReconcile).toBeUndefined();
  });
});

describe('host-agent-routed restore/wipe (#1600 — stacks dir not in container)', () => {
  // The real host agent runs these argv ops on /mnt/data/stacks, which the
  // servicebay container can't see. The unit env has no agent, so this Executor
  // stand-in runs the SAME argv against the test's real temp fs — proving the
  // routed path actually wipes + extracts (not the in-container no-op of #1600).
  function makeHostExecutor() {
    const run = (argv: string[]) => execFileAsync(argv[0], argv.slice(1));
    const exec: {
      execArgv: ReturnType<typeof vi.fn>;
      exists: ReturnType<typeof vi.fn>;
      writeFile: ReturnType<typeof vi.fn>;
    } = {
      execArgv: vi.fn(async (argv: string[]) => {
        // `sh -c <script> sh <args...>` — run the script with positional args.
        if (argv[0] === 'sh' && argv[1] === '-c') {
          const script = argv[2];
          const rest = argv.slice(3); // [$0, $1, $2, ...]
          const { stdout, stderr } = await execFileAsync('sh', ['-c', script, ...rest]);
          return { stdout, stderr };
        }
        const { stdout, stderr } = await run(argv);
        return { stdout, stderr };
      }),
      exists: vi.fn(async (p: string) => {
        try { await fs.access(p); return true; } catch { return false; }
      }),
      writeFile: vi.fn(async (p: string, content: string) => { await fs.writeFile(p, content); }),
    };
    return exec;
  }

  beforeEach(() => {
    mockGetExecutor.mockImplementation(() => makeHostExecutor());
  });

  it('restore: extracts the NAS tar onto the host (agent), counting host files', async () => {
    serveTar(await buildServiceTar({ 'configuration.yaml': 'host-restored:', '.storage/zwave_js': '{"k":2}' }));
    const res = await restoreServiceBackup('home-assistant', { node: 'Local' });
    expect(mockGetExecutor).toHaveBeenCalledWith('Local');
    expect(res.files).toBe(2);
    // Files landed on the (host = temp) data dir, via the agent path.
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('host-restored:');
    expect(await fs.readFile(path.join(dataDir, '.storage/zwave_js'), 'utf8')).toBe('{"k":2}');
  });

  it('restore: refuses a non-empty host data dir without force (agent ls -A)', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'live.yaml'), 'live');
    serveTar(await buildServiceTar({ 'configuration.yaml': 'incoming' }));
    await expect(restoreServiceBackup('home-assistant', { node: 'Local' })).rejects.toThrow(/already has data/);
    expect(await fs.readFile(path.join(dataDir, 'live.yaml'), 'utf8')).toBe('live');
  });

  it('wipe-config: clears CONFIG paths on the host, keeps DATA (agent rm -rf)', async () => {
    await fs.mkdir(path.join(dataDir, '.storage'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    await fs.writeFile(path.join(dataDir, '.storage/zwave_js'), 'keys');
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'RECORDER');
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'wipe-config', node: 'Local' }, async l => { logs.push(l); });
    await expect(fs.access(path.join(dataDir, 'configuration.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, '.storage/zwave_js'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dataDir, 'home-assistant_v2.db'), 'utf8')).toBe('RECORDER');
    expect(logs.some(l => l.includes('wipe-config') && l.includes('kept the service data'))).toBe(true);
  });

  it('wipe-all: clears the whole host data dir (agent rm -rf)', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'RECORDER');
    const logs: string[] = [];
    await wipeServiceForReinstall('home-assistant', { wipeMode: 'wipe-all', node: 'Local' }, async l => { logs.push(l); });
    await expect(fs.access(dataDir)).rejects.toThrow();
    expect(logs.some(l => l.includes('wipe-all'))).toBe(true);
  });

  it('autoRestore wipe-config: force-restores config over kept host data (agent path)', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'home-assistant.tar', size: 1024 }]);
    serveTar(await buildServiceTar({ 'configuration.yaml': 'reseeded:', '.storage/zwave_js': '{"k":3}' }));
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'home-assistant_v2.db'), 'KEPT-DB');
    const logs: string[] = [];
    await autoRestoreServiceOnReinstall('home-assistant', { wipeMode: 'wipe-config', node: 'Local' }, async l => { logs.push(l); });
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('reseeded:');
    expect(await fs.readFile(path.join(dataDir, 'home-assistant_v2.db'), 'utf8')).toBe('KEPT-DB');
    expect(logs.some(l => l.includes('restored') && l.includes('home-assistant'))).toBe(true);
  });
});
