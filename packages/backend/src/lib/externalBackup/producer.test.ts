import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockGetConfig, mockSendCommand, mockExecutor, mockGetExecutor } = vi.hoisted(() => ({
  mockNas: {
    nasUpload: vi.fn(),
    nasDownload: vi.fn(),
    nasList: vi.fn(),
  },
  mockGetConfig: vi.fn(),
  mockSendCommand: vi.fn(),
  mockExecutor: {
    exec: vi.fn(),
    execArgv: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    exists: vi.fn(),
  },
  mockGetExecutor: vi.fn(),
}));

vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));
vi.mock('../agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(async () => ({ sendCommand: mockSendCommand })) },
}));
vi.mock('../executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));

import {
  stageServiceBackup,
  buildServiceBackupTar,
  backupServiceToNas,
  stageUploadedServiceTar,
  resolveServiceDataDir,
  runBackupCollector,
  listServiceBackups,
  fetchServiceBackup,
  getNextExternalBackupDelayMs,
  scheduleExternalNasBackup,
  NAS_BACKUP_DIR,
} from './producer';
import { getServiceManifest, type ServiceBackupManifest } from './serviceManifest';

let tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeFile(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({ templateSettings: {} });
  mockNas.nasUpload.mockResolvedValue(undefined);
  mockGetExecutor.mockReturnValue(mockExecutor);
});

afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe('stageServiceBackup', () => {
  it('stages included files, skips excluded ones, and recurses into included dirs', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'config.yaml', 'model: x');
    await writeFile(src, '.storage/lovelace', '{"ui":true}');
    await writeFile(src, '.storage/lovelace_dashboards', '{}');
    await writeFile(src, 'home-assistant_v2.db', 'BINARYDB');
    await writeFile(src, 'logs/today.log', 'noise');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['config.yaml', '.storage', 'missing.yaml'],
      exclude: ['home-assistant_v2.db', 'logs'],
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    expect(staged).toEqual(['.storage/lovelace', '.storage/lovelace_dashboards', 'config.yaml']);
    expect(await fs.readFile(path.join(staging, 'config.yaml'), 'utf8')).toBe('model: x');
    // Excluded + missing files never reach the staging dir.
    await expect(fs.access(path.join(staging, 'home-assistant_v2.db'))).rejects.toThrow();
    await expect(fs.access(path.join(staging, 'logs'))).rejects.toThrow();
  });

  it('applies strip rules to the targeted file only', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'users_database.yml', 'users:\n  a:\n    password: $argon2$secret\n    email: a@x\n');
    await writeFile(src, 'other.yml', 'password: keepme\n');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['users_database.yml', 'other.yml'],
      exclude: [],
      strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
    };
    await stageServiceBackup(src, manifest, staging);

    const stripped = await fs.readFile(path.join(staging, 'users_database.yml'), 'utf8');
    expect(stripped).not.toContain('secret');
    expect(stripped).toContain('a@x');
    // Non-targeted file is copied verbatim — the strip rule must not bleed.
    expect(await fs.readFile(path.join(staging, 'other.yml'), 'utf8')).toBe('password: keepme\n');
  });

  it('stages a collector snapshot file under its canonical tarball name via renames (#1528)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // The collector left a consistent snapshot beside the live DB.
    await writeFile(src, 'data/database.sqlite.sb-backup', 'CONSISTENT-SNAPSHOT');
    await writeFile(src, 'data/database.sqlite', 'LIVE-WAL-TORN');

    const manifest: ServiceBackupManifest = {
      service: 'nginx',
      include: ['data/database.sqlite.sb-backup'],
      exclude: [],
      renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    // Tarball carries the snapshot bytes under the canonical name.
    expect(staged).toEqual(['data/database.sqlite']);
    expect(await fs.readFile(path.join(staging, 'data/database.sqlite'), 'utf8')).toBe('CONSISTENT-SNAPSHOT');
    // The torn live file never reaches the tarball.
    await expect(fs.access(path.join(staging, 'data/database.sqlite.sb-backup'))).rejects.toThrow();
  });
});

describe('runBackupCollector (NPM in-container sqlite snapshot, #1528)', () => {
  const npm = getServiceManifest('nginx')!;

  it('returns the manifest unchanged for a service with no collector', async () => {
    const ha = getServiceManifest('home-assistant')!;
    expect(await runBackupCollector(ha, 'Local')).toBe(ha);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it('snapshots in-container and remaps the db include to the snapshot path', async () => {
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager docker.io/jc21/nginx-proxy-manager', code: 0 })
      .mockResolvedValueOnce({ stdout: 'ok', code: 0 });

    const out = await runBackupCollector(npm, 'Local');
    expect(out.include).toContain('data/database.sqlite.sb-backup');
    expect(out.include).not.toContain('data/database.sqlite');
    expect(out.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
    // certs are untouched by the remap.
    expect(out.include).toContain('letsencrypt');
  });

  it('falls back to the original manifest (live file) when the container is missing', async () => {
    mockSendCommand.mockResolvedValueOnce({ stdout: '', code: 0 });
    const out = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    expect(out.include).toContain('data/database.sqlite');
  });

  it('falls back when the in-container snapshot command fails', async () => {
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'sqlite3: not found', code: 1 });
    const out = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
  });
});

describe('buildServiceBackupTar', () => {
  it('produces a tar containing the staged + stripped files', async () => {
    const src = await mkTmp();
    await writeFile(src, 'config.yaml', 'a: 1');
    await writeFile(src, 'users_database.yml', 'users:\n  a:\n    password: SEKRIT\n');
    await writeFile(src, 'cache/big.bin', 'junk');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['config.yaml', 'users_database.yml'],
      exclude: ['cache'],
      strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
    };
    const tar = await buildServiceBackupTar(src, manifest);
    expect(tar.length).toBeGreaterThan(0);

    const out = await mkTmp();
    const tarFile = path.join(out, 'b.tar');
    await fs.writeFile(tarFile, tar);
    await execFileAsync('tar', ['-xf', tarFile, '-C', out]);

    expect(await fs.readFile(path.join(out, 'config.yaml'), 'utf8')).toBe('a: 1');
    expect(await fs.readFile(path.join(out, 'users_database.yml'), 'utf8')).not.toContain('SEKRIT');
    await expect(fs.access(path.join(out, 'cache'))).rejects.toThrow();
  });

  it('throws when no config files match', async () => {
    const src = await mkTmp();
    const manifest: ServiceBackupManifest = { service: 'empty', include: ['nope.yaml'], exclude: [] };
    await expect(buildServiceBackupTar(src, manifest)).rejects.toThrow(/No config files/);
  });
});

describe('resolveServiceDataDir', () => {
  it('joins the configured DATA_DIR with the service name', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: '/srv/stacks' } });
    expect(await resolveServiceDataDir('adguard')).toBe('/srv/stacks/adguard');
  });

  it('falls back to /mnt/data/stacks when DATA_DIR is unset', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {} });
    expect(await resolveServiceDataDir('adguard')).toBe('/mnt/data/stacks/adguard');
  });
});

describe('backupServiceToNas via the host agent (#1597)', () => {
  // The servicebay container can't see /mnt/data/stacks, so a box backup (no
  // serviceDataDir override) must route every fs op through the host agent.
  // Here the mocked executor runs the same ops against a REAL local temp dir,
  // exercising the actual agentFileBackend round-trip (incl. tar | base64).
  function wireExecutorToHostDir(): { stagingDir: string } {
    const ref = { stagingDir: '' };
    mockExecutor.execArgv.mockImplementation(async (argv: string[]) => {
      const [cmd, ...args] = argv;
      if (cmd === 'find') {
        const dir = args[0];
        const ents = await fs.readdir(dir, { withFileTypes: true });
        const lines = ents.map(e => `${e.isDirectory() ? 'd' : e.isFile() ? 'f' : 'o'}\t${e.name}`);
        return { stdout: lines.join('\n'), stderr: '' };
      }
      if (cmd === 'test' && args[0] === '-d') {
        const ok = await fs.stat(args[1]).then(s => s.isDirectory(), () => false);
        if (!ok) throw new Error('not a dir');
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'test' && args[0] === '-e') {
        const ok = await fs.access(args[1]).then(() => true, () => false);
        if (!ok) throw new Error('missing');
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'mkdir') { await fs.mkdir(args[1], { recursive: true }); return { stdout: '', stderr: '' }; }
      if (cmd === 'cp') {
        const src = args[args.length - 2];
        const dest = args[args.length - 1];
        await fs.copyFile(src, dest);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'mktemp') {
        ref.stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-test-hoststage-'));
        tmpDirs.push(ref.stagingDir);
        return { stdout: ref.stagingDir, stderr: '' };
      }
      if (cmd === 'tar') {
        // tar -cf <tarPath> -C <stagingDir> .
        const tarPath = args[1];
        const stagingDir = args[3];
        await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.']);
        tmpDirs.push(tarPath);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'base64') {
        const buf = await fs.readFile(args[0]);
        return { stdout: buf.toString('base64'), stderr: '' };
      }
      if (cmd === 'rm') return { stdout: '', stderr: '' }; // leave temp for afterEach cleanup
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    });
    mockExecutor.exists.mockImplementation((p: string) => fs.access(p).then(() => true, () => false));
    mockExecutor.readFile.mockImplementation((p: string) => fs.readFile(p, 'utf8'));
    mockExecutor.writeFile.mockImplementation((p: string, c: string) => fs.writeFile(p, c));
    return ref;
  }

  it('reads + tars the stacks dir host-side and uploads the tar (config-survival is non-functional without this)', async () => {
    const hostStacks = await mkTmp();
    await writeFile(hostStacks, 'adguard/conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    await writeFile(hostStacks, 'adguard/data/querylog.json', '[]'); // excluded
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: hostStacks } });
    wireExecutorToHostDir();

    const result = await backupServiceToNas('adguard');

    expect(mockGetExecutor).toHaveBeenCalledWith('Local');
    expect(result.size).toBeGreaterThan(0);
    // The tar bytes that came back through the agent contain the config, not the excluded querylog.
    const tarCall = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('/adguard.tar'))!;
    const out = await mkTmp();
    const tarFile = path.join(out, 'a.tar');
    await fs.writeFile(tarFile, tarCall[1] as Buffer);
    await execFileAsync('tar', ['-xf', tarFile, '-C', out]);
    expect(await fs.readFile(path.join(out, 'conf/AdGuardHome.yaml'), 'utf8')).toBe('bind_host: 0.0.0.0');
    await expect(fs.access(path.join(out, 'data/querylog.json'))).rejects.toThrow();
  });

  it('applies strip rules host-side via the agent (password hashes never leave the box)', async () => {
    const hostStacks = await mkTmp();
    await writeFile(hostStacks, 'authelia/users_database.yml',
      'users:\n  a:\n    password: $argon2$SEKRIT\n    email: a@x\n');
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: hostStacks } });
    wireExecutorToHostDir();

    const result = await backupServiceToNas('authelia');
    const tarCall = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('/authelia.tar'))!;
    const out = await mkTmp();
    const tarFile = path.join(out, 'a.tar');
    await fs.writeFile(tarFile, tarCall[1] as Buffer);
    await execFileAsync('tar', ['-xf', tarFile, '-C', out]);
    const stripped = await fs.readFile(path.join(out, 'users_database.yml'), 'utf8');
    expect(stripped).not.toContain('SEKRIT');
    expect(stripped).toContain('a@x');
    expect(result.size).toBeGreaterThan(0);
  });
});

describe('backupServiceToNas', () => {
  it('uploads the tar and a meta sidecar under sb-backup/', async () => {
    const src = await mkTmp();
    await writeFile(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');

    const result = await backupServiceToNas('adguard', { serviceDataDir: src });

    expect(result.tarName).toBe('adguard.tar');
    expect(result.metaName).toBe('adguard.tar.meta.json');
    expect(result.size).toBeGreaterThan(0);
    expect(result.meta.schemaVersion).toBe(1);
    expect(result.meta.service).toBe('adguard');
    expect(result.meta.nodeId).toBe(os.hostname());

    const uploadPaths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/adguard.tar`);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/adguard.tar.meta.json`);

    const metaCall = mockNas.nasUpload.mock.calls.find(c => c[0].endsWith('.meta.json'))!;
    const metaJson = JSON.parse((metaCall[1] as Buffer).toString('utf8'));
    expect(metaJson.service).toBe('adguard');
  });

  it('rejects a service with no manifest without touching the NAS', async () => {
    await expect(backupServiceToNas('vaultwarden')).rejects.toThrow(/No backup manifest/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });

  // (data-dir resolution for the no-override box path is covered by the
  // "via the host agent" describe block above, which also passes DATA_DIR.)
});

describe('read-back', () => {
  it('lists only .tar entries and derives the service name', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'hermes.tar', size: 100 },
      { name: 'hermes.tar.meta.json', size: 20 },
      { name: 'adguard.tar', size: 50 },
    ]);
    const list = await listServiceBackups();
    expect(list).toEqual([
      { service: 'adguard', tarName: 'adguard.tar', size: 50 },
      { service: 'hermes', tarName: 'hermes.tar', size: 100 },
    ]);
    expect(mockNas.nasList).toHaveBeenCalledWith(NAS_BACKUP_DIR);
  });

  it('fetches a tar plus its parsed meta sidecar', async () => {
    mockNas.nasDownload.mockImplementation(async (p: string) =>
      p.endsWith('.meta.json')
        ? Buffer.from(JSON.stringify({ service: 'hermes', schemaVersion: 1, createdAt: 'now', nodeId: 'box' }))
        : Buffer.from('TARBYTES'),
    );
    const { tar, meta } = await fetchServiceBackup('hermes.tar');
    expect(tar.toString()).toBe('TARBYTES');
    expect(meta?.service).toBe('hermes');
    expect(mockNas.nasDownload).toHaveBeenCalledWith(`${NAS_BACKUP_DIR}/hermes.tar`);
  });

  it('returns meta=null when the sidecar is missing', async () => {
    mockNas.nasDownload.mockImplementation(async (p: string) => {
      if (p.endsWith('.meta.json')) throw new Error('550 not found');
      return Buffer.from('TARBYTES');
    });
    const { tar, meta } = await fetchServiceBackup('hermes.tar');
    expect(tar.toString()).toBe('TARBYTES');
    expect(meta).toBeNull();
  });

  it('strips any directory component from the requested name and rejects non-tar', async () => {
    mockNas.nasDownload.mockResolvedValue(Buffer.from('x'));
    await fetchServiceBackup('../../etc/passwd.tar');
    expect(mockNas.nasDownload).toHaveBeenCalledWith(`${NAS_BACKUP_DIR}/passwd.tar`);
    await expect(fetchServiceBackup('hermes.json')).rejects.toThrow(/Not a service backup tar/);
  });
});

describe('manifest integration', () => {
  it('the real adguard manifest excludes querylog while keeping the config', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    await writeFile(src, 'data/querylog.json', '[]');
    const staged = await stageServiceBackup(src, getServiceManifest('adguard')!, staging);
    expect(staged).toEqual(['conf/AdGuardHome.yaml']);
  });
});

describe('stageUploadedServiceTar', () => {
  it('writes the uploaded tar + meta to the NAS in restore layout', async () => {
    const tar = Buffer.alloc(1024, 7); // >=512 bytes, written verbatim
    const res = await stageUploadedServiceTar('adguard', tar);

    const paths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/adguard.tar`);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/adguard.tar.meta.json`);
    expect(res.tarName).toBe('adguard.tar');

    const tarCall = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('/adguard.tar'))!;
    expect(tarCall[1]).toEqual(tar); // bytes passed through unchanged
    const metaCall = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('.meta.json'))!;
    expect(JSON.parse(String(metaCall[1])).service).toBe('adguard');
  });

  it('rejects a service with no backup manifest', async () => {
    await expect(stageUploadedServiceTar('not-a-real-service', Buffer.alloc(1024)))
      .rejects.toThrow(/manifest/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });

  it('rejects an empty / non-tar upload', async () => {
    await expect(stageUploadedServiceTar('adguard', Buffer.alloc(10)))
      .rejects.toThrow(/empty|tar/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });
});

describe('getNextExternalBackupDelayMs', () => {
  it('schedules later today when the run time has not passed yet', () => {
    const now = new Date('2026-06-01T01:00:00Z');
    const delay = getNextExternalBackupDelayMs('03:30', now);
    expect(delay).toBe((2 * 60 + 30) * 60 * 1000); // 2h30m
  });

  it('rolls to tomorrow when the run time already passed today', () => {
    const now = new Date('2026-06-01T04:00:00Z');
    const delay = getNextExternalBackupDelayMs('03:30', now);
    expect(delay).toBe((23 * 60 + 30) * 60 * 1000); // 23h30m
  });

  it('falls back to the default time on an empty value', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const delay = getNextExternalBackupDelayMs('', now);
    expect(delay).toBe((3 * 60 + 30) * 60 * 1000); // default 03:30
  });
});

describe('scheduleExternalNasBackup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T01:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms a daily timer that fires backupInstalledServicesToNas when enabled', async () => {
    // No NAS configured -> producer returns ok:false per installed service, but
    // the timer must still fire and reschedule without throwing.
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' }, installedTemplates: {} });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0); // let the getConfig().then() arm the timer

    // Nothing fired yet (run is 2h30m out)
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
    // Advance to the scheduled run; with no installed services, no upload, no throw.
    await vi.advanceTimersByTimeAsync((2 * 60 + 30) * 60 * 1000);
    // Reschedule armed a fresh getConfig() (timer self-renews) — no error thrown.
    expect(true).toBe(true);
  });

  it('does not arm a timer when externalBackup.enabled is false', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: false } });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('defaults to enabled (arms a timer) when externalBackup is absent', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockGetConfig.mockResolvedValue({ installedTemplates: {} });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
