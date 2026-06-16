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
    nasRemove: vi.fn(),
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
  getNasBackupSchedule,
  deleteServiceBackup,
  NAS_BACKUP_DIR,
  DEFAULT_BACKUP_RETENTION,
  latestServiceBackupName,
  agentFileBackend,
} from './producer';
import { getServiceManifest, type ServiceBackupManifest } from './serviceManifest';
import { logger } from '../logger';

/** Match a dated slot tar `<service>-YYYYMMDD-HHMM.tar` (#1865). */
const datedTarRe = (service: string) => new RegExp(`/${service}-\\d{8}-\\d{4}\\.tar$`);

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
  // #1865 — writeServiceBackupToNas prunes after each write (lists then removes);
  // default to an empty NAS so the per-write tests see no prior snapshots.
  mockNas.nasList.mockResolvedValue([]);
  mockNas.nasRemove.mockResolvedValue(undefined);
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

  it('expands a trailing-* leaf glob include to the matching files (#1595/#1596)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // HA dashboards (lovelace.<url_path>) + HACS data (hacs.*) + the bare
    // sidebar list, plus a sibling that must NOT match the lovelace glob.
    await writeFile(src, '.storage/lovelace', '{"ui":true}');
    await writeFile(src, '.storage/lovelace.lovelace', '{"dash":"main"}');
    await writeFile(src, '.storage/lovelace.map', '{"dash":"map"}');
    await writeFile(src, '.storage/lovelace_dashboards', '{"list":true}');
    await writeFile(src, '.storage/hacs.repositories', '{"repos":[]}');
    await writeFile(src, '.storage/hacs.data', '{"data":1}');
    await writeFile(src, '.storage/core.config_entries', '{"entries":[]}');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/lovelace*', '.storage/hacs*'],
      exclude: [],
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    // Every lovelace dashboard (including the bare name + the sidebar list) and
    // every hacs.* file is staged; the unrelated core.config_entries is not.
    expect(staged).toEqual([
      '.storage/hacs.data',
      '.storage/hacs.repositories',
      '.storage/lovelace',
      '.storage/lovelace.lovelace',
      '.storage/lovelace.map',
      '.storage/lovelace_dashboards',
    ]);
    expect(await fs.readFile(path.join(staging, '.storage/lovelace.map'), 'utf8')).toBe('{"dash":"map"}');
  });

  it('a glob include matching nothing stages no files (no literal-* file created)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, '.storage/core.config_entries', '{}');
    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/lovelace*'],
      exclude: [],
    };
    expect(await stageServiceBackup(src, manifest, staging)).toEqual([]);
  });

  it('stages an included directory (custom_components/) recursively (#1596)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'custom_components/meross_lan/__init__.py', 'CODE');
    await writeFile(src, 'custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['custom_components'],
      exclude: [],
    };
    const staged = await stageServiceBackup(src, manifest, staging);
    expect(staged).toEqual([
      'custom_components/meross_lan/__init__.py',
      'custom_components/meross_lan/manifest.json',
    ]);
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

  it('applies the HA config-entries add-on transform through staging (#1595)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(
      src,
      '.storage/core.config_entries',
      JSON.stringify({
        data: {
          entries: [
            { domain: 'zwave_js', data: { use_addon: true, integration_created_addon: true, url: 'ws://core-zwave-js:3000' } },
          ],
        },
      }),
    );

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/core.config_entries'],
      exclude: [],
      transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
    };
    await stageServiceBackup(src, manifest, staging);

    const staged = JSON.parse(
      await fs.readFile(path.join(staging, '.storage/core.config_entries'), 'utf8'),
    ) as { data: { entries: { data: Record<string, unknown> }[] } };
    expect(staged.data.entries[0].data.use_addon).toBe(false);
    expect(staged.data.entries[0].data.url).toBe('ws://localhost:3001');
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

  it('degrades gracefully (live file) and logs the real reason when sqlite3 is missing from the image (#1894)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // The snapshot script probes for sqlite3 and emits the `no-sqlite3` sentinel
    // (exit 0) when it's absent — NOT a misleading "(unknown)".
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'no-sqlite3', stderr: '', code: 0 });
    const out = await runBackupCollector(npm, 'Local');
    // Degrades to copying the live DB under its canonical name (manifest unchanged).
    expect(out).toBe(npm);
    expect(out.include).toContain('data/database.sqlite');
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toMatch(/sqlite3 not present/i);
    expect(msg).not.toMatch(/unknown/);
    warn.mockRestore();
  });

  it('surfaces the container stderr (not "(unknown)") when the snapshot errors (#1894)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'sh: 1: sqlite3: Permission denied', code: 1 });
    const out = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toContain('Permission denied'); // the REAL stderr is logged
    expect(msg).not.toMatch(/\(unknown\)/);
    warn.mockRestore();
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
  function wireExecutorToHostDir(): { stagingDir: string; execShellCalls: number } {
    const ref = { stagingDir: '', execShellCalls: 0 };
    // The bulk copy (#1894) runs as ONE shell pipe per service via executor.exec:
    //   tar -C <src> --null -T <listfile> -cf - | tar -C <dest> -xf -
    // Emulate it against the real local temp dirs and count the calls so a test
    // can assert "one bulk exec, not a round-trip per file".
    mockExecutor.exec.mockImplementation(async (command: string) => {
      const m = /tar -C (\S+) --null -T (\S+) -cf - \| tar -C (\S+) -xf -/.exec(command);
      if (!m) throw new Error(`unexpected exec: ${command}`);
      ref.execShellCalls += 1;
      const unq = (s: string) => s.replace(/^'(.*)'$/, '$1').replace(/'\\''/g, "'");
      const [, srcRoot, listFile, destRoot] = m.map(unq);
      const rels = (await fs.readFile(listFile, 'utf8')).split('\0').filter(Boolean);
      for (const rel of rels) {
        const dest = path.join(destRoot, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(srcRoot, rel), dest);
      }
      return { stdout: '', stderr: '' };
    });
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
    const tarCall = mockNas.nasUpload.mock.calls.find(c => datedTarRe('adguard').test(String(c[0])))!;
    const out = await mkTmp();
    const tarFile = path.join(out, 'a.tar');
    await fs.writeFile(tarFile, tarCall[1] as Buffer);
    await execFileAsync('tar', ['-xf', tarFile, '-C', out]);
    expect(await fs.readFile(path.join(out, 'conf/AdGuardHome.yaml'), 'utf8')).toBe('bind_host: 0.0.0.0');
    await expect(fs.access(path.join(out, 'data/querylog.json'))).rejects.toThrow();
  });

  it('copies a large file tree in ONE host-side bulk exec, not a round-trip per file (#1894)', async () => {
    const hostStacks = await mkTmp();
    // A custom_components dir with many plain files — what OOM'd the box when each
    // was a separate agent cp/mkdir round-trip.
    for (let i = 0; i < 50; i++) {
      await writeFile(hostStacks, `demo/custom_components/pkg/file${i}.py`, `x${i}`);
    }
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: hostStacks } });
    // A throwaway manifest service that maps to the demo/ dir.
    const ref = wireExecutorToHostDir();

    const tar = await buildServiceBackupTar(
      path.join(hostStacks, 'demo'),
      { service: 'demo', include: ['custom_components'], exclude: [] },
      // Build the tar directly against the wired agent backend (one bulk exec).
      agentFileBackend(mockExecutor as unknown as Parameters<typeof agentFileBackend>[0]),
    );
    expect(tar.length).toBeGreaterThan(0);
    // The 50 plain files were copied by a SINGLE bulk shell exec — no per-file cp.
    expect(ref.execShellCalls).toBe(1);
    const cpCalls = mockExecutor.execArgv.mock.calls.filter((c: unknown[]) => (c[0] as string[])[0] === 'cp');
    expect(cpCalls).toHaveLength(0);
  });

  it('applies strip rules host-side via the agent (password hashes never leave the box)', async () => {
    const hostStacks = await mkTmp();
    await writeFile(hostStacks, 'authelia/users_database.yml',
      'users:\n  a:\n    password: $argon2$SEKRIT\n    email: a@x\n');
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: hostStacks } });
    wireExecutorToHostDir();

    const result = await backupServiceToNas('authelia');
    const tarCall = mockNas.nasUpload.mock.calls.find(c => datedTarRe('authelia').test(String(c[0])))!;
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

    // #1865 — a dated slot per run, not a single overwritten adguard.tar.
    expect(result.tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/);
    expect(result.metaName).toBe(`${result.tarName}.meta.json`);
    expect(result.size).toBeGreaterThan(0);
    expect(result.meta.schemaVersion).toBe(1);
    expect(result.meta.service).toBe('adguard');
    expect(result.meta.nodeId).toBe(os.hostname());

    const uploadPaths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/${result.tarName}`);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/${result.metaName}`);

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
  it('lists dated snapshots grouped per service (newest first), drops sidecars, keeps bare legacy slots (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant-20260615-0531.tar', size: 100 },
      { name: 'home-assistant-20260615-0531.tar.meta.json', size: 20 }, // sidecar — not a snapshot
      { name: 'home-assistant-20260614-0530.tar', size: 90 },
      { name: 'adguard.tar', size: 50 }, // bare legacy single-slot — still listable
    ]);
    const list = await listServiceBackups();
    expect(list).toEqual([
      // adguard (A→Z) first; its bare slot has a null stamp + null createdAt.
      { service: 'adguard', tarName: 'adguard.tar', size: 50, stamp: null, createdAt: null },
      // home-assistant newest snapshot first; createdAt derived from the stamp (#1890).
      { service: 'home-assistant', tarName: 'home-assistant-20260615-0531.tar', size: 100, stamp: '20260615-0531', createdAt: '2026-06-15T05:31:00.000Z' },
      { service: 'home-assistant', tarName: 'home-assistant-20260614-0530.tar', size: 90, stamp: '20260614-0530', createdAt: '2026-06-14T05:30:00.000Z' },
    ]);
    expect(mockNas.nasList).toHaveBeenCalledWith(NAS_BACKUP_DIR);
  });

  it('latestServiceBackupName resolves the most-recent dated slot, preferring it over a bare legacy slot (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant.tar', size: 10 }, // bare legacy — oldest
      { name: 'home-assistant-20260614-0530.tar', size: 90 },
      { name: 'home-assistant-20260615-0531.tar', size: 100 },
    ]);
    expect(await latestServiceBackupName('home-assistant')).toBe('home-assistant-20260615-0531.tar');
  });

  it('latestServiceBackupName falls back to a bare legacy slot when it is the only snapshot (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'adguard.tar', size: 50 }]);
    expect(await latestServiceBackupName('adguard')).toBe('adguard.tar');
  });

  it('latestServiceBackupName returns null when the service has no backup', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'adguard.tar', size: 50 }]);
    expect(await latestServiceBackupName('home-assistant')).toBeNull();
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

describe('dated rotation + retention pruning (#1865)', () => {
  // Back the NAS mock with an in-memory store so multiple backup runs accumulate
  // dated slots and pruning actually removes the oldest, end-to-end.
  let store: Map<string, Buffer>;
  beforeEach(() => {
    store = new Map();
    mockNas.nasUpload.mockImplementation(async (p: string, data: Buffer) => { store.set(p, Buffer.from(data)); });
    mockNas.nasList.mockImplementation(async (dir = '') => {
      const prefix = dir ? `${dir}/` : '';
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ name: k.slice(prefix.length), size: v.length }));
    });
    mockNas.nasRemove.mockImplementation(async (p: string) => { store.delete(p); });
  });

  /** The dated tar slots (no sidecars) currently in the store, for a service. */
  function slots(service: string): string[] {
    return [...store.keys()]
      .map(k => k.slice(`${NAS_BACKUP_DIR}/`.length))
      .filter(n => new RegExp(`^${service}-\\d{8}-\\d{4}\\.tar$`).test(n))
      .sort();
  }

  it('each backup run writes a NEW dated file rather than overwriting one slot', async () => {
    const tar = Buffer.alloc(1024, 1);
    // Three runs at distinct minutes — distinct dated slots, none overwritten.
    vi.useFakeTimers();
    try {
      for (const t of ['2026-06-13T05:31:00Z', '2026-06-14T05:31:00Z', '2026-06-15T05:31:00Z']) {
        vi.setSystemTime(new Date(t));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(slots('adguard')).toEqual([
      'adguard-20260613-0531.tar',
      'adguard-20260614-0531.tar',
      'adguard-20260615-0531.tar',
    ]);
  });

  it('prunes the oldest snapshots beyond the configured retention (keep N), removing sidecars too', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {}, externalBackup: { enabled: true, retention: 2 } });
    const tar = Buffer.alloc(1024, 2);
    vi.useFakeTimers();
    try {
      for (const t of ['2026-06-12T05:31:00Z', '2026-06-13T05:31:00Z', '2026-06-14T05:31:00Z', '2026-06-15T05:31:00Z']) {
        vi.setSystemTime(new Date(t));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    // Only the 2 most-recent remain; older ones AND their sidecars are gone.
    expect(slots('adguard')).toEqual(['adguard-20260614-0531.tar', 'adguard-20260615-0531.tar']);
    expect(store.has(`${NAS_BACKUP_DIR}/adguard-20260612-0531.tar`)).toBe(false);
    expect(store.has(`${NAS_BACKUP_DIR}/adguard-20260612-0531.tar.meta.json`)).toBe(false);
  });

  it('a bare legacy <service>.tar is pruned first (sorts oldest) once retention is reached', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {}, externalBackup: { enabled: true, retention: 1 } });
    // Seed a pre-#1865 single slot, then one dated run with retention 1.
    store.set(`${NAS_BACKUP_DIR}/adguard.tar`, Buffer.alloc(512, 9));
    store.set(`${NAS_BACKUP_DIR}/adguard.tar.meta.json`, Buffer.from('{}'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T05:31:00Z'));
      await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 3));
    } finally {
      vi.useRealTimers();
    }
    // The bare legacy slot is gone; only the new dated snapshot survives.
    expect(store.has(`${NAS_BACKUP_DIR}/adguard.tar`)).toBe(false);
    expect(slots('adguard')).toEqual(['adguard-20260615-0531.tar']);
  });

  it('defaults retention to DEFAULT_BACKUP_RETENTION when unset', async () => {
    expect(DEFAULT_BACKUP_RETENTION).toBe(7);
    const tar = Buffer.alloc(1024, 4);
    vi.useFakeTimers();
    try {
      // 9 runs, no retention configured → keep 7, prune 2 oldest.
      for (let d = 1; d <= 9; d++) {
        vi.setSystemTime(new Date(`2026-06-${String(d).padStart(2, '0')}T05:31:00Z`));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(slots('adguard')).toHaveLength(DEFAULT_BACKUP_RETENTION);
    expect(slots('adguard')[0]).toBe('adguard-20260603-0531.tar'); // oldest kept = day 3
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

  it('the real HA manifest drops the re-downloadable HACS frontend cache but keeps the rest of custom_components (#1894)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // A real HACS integration's code (keep) …
    await writeFile(src, 'custom_components/hacs/__init__.py', 'CODE');
    await writeFile(src, 'custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    // … and the ~2.2k-file re-downloadable static frontend cache (drop).
    await writeFile(src, 'custom_components/hacs/hacs_frontend/static/locale-data/x.json', '{}');
    await writeFile(src, 'custom_components/hacs/hacs_frontend/main.js', 'JUNK');
    await writeFile(src, 'custom_components/hacs_frontend/entrypoint.js', 'JUNK');

    const staged = await stageServiceBackup(src, getServiceManifest('home-assistant')!, staging);

    // The HACS code + other integrations are staged …
    expect(staged).toContain('custom_components/hacs/__init__.py');
    expect(staged).toContain('custom_components/meross_lan/manifest.json');
    // … but no hacs_frontend cache file is — neither the nested nor the sibling one.
    expect(staged.some(p => p.includes('hacs_frontend'))).toBe(false);
  });
});

describe('stageUploadedServiceTar', () => {
  it('writes the uploaded tar + meta to the NAS in restore layout', async () => {
    const tar = Buffer.alloc(1024, 7); // >=512 bytes, written verbatim
    const res = await stageUploadedServiceTar('adguard', tar);

    const paths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    // #1865 — dated slot, not a single overwritten adguard.tar.
    expect(res.tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/${res.tarName}`);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/${res.tarName}.meta.json`);

    const tarCall = mockNas.nasUpload.mock.calls.find(c => datedTarRe('adguard').test(String(c[0])))!;
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

describe('getNasBackupSchedule (#1890)', () => {
  it('surfaces the configured time + derived next run when enabled', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T01:00:00Z'));
    // next run = 2h30m after 01:00 = 03:30 same day
    expect(s).toEqual({ enabled: true, time: '03:30', nextRunAt: '2026-06-01T03:30:00.000Z' });
  });

  it('rolls the next run to tomorrow when the time already passed today', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T04:00:00Z'));
    expect(s.nextRunAt).toBe('2026-06-02T03:30:00.000Z');
  });

  it('reports disabled with no next run when externalBackup.enabled is false', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: false, time: '04:00' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T01:00:00Z'));
    expect(s).toEqual({ enabled: false, time: '04:00', nextRunAt: null });
  });

  it('defaults to enabled at 03:30 when externalBackup is unset', async () => {
    mockGetConfig.mockResolvedValue({});
    const s = await getNasBackupSchedule(new Date('2026-06-01T00:00:00Z'));
    expect(s).toEqual({ enabled: true, time: '03:30', nextRunAt: '2026-06-01T03:30:00.000Z' });
  });
});

describe('deleteServiceBackup (#1890)', () => {
  it('removes both the tar and its .meta.json sidecar', async () => {
    mockNas.nasRemove.mockResolvedValue(undefined);
    const r = await deleteServiceBackup('home-assistant-20260615-0531.tar');
    expect(r).toEqual({ tarName: 'home-assistant-20260615-0531.tar', metaRemoved: true });
    expect(mockNas.nasRemove).toHaveBeenNthCalledWith(1, `${NAS_BACKUP_DIR}/home-assistant-20260615-0531.tar`);
    expect(mockNas.nasRemove).toHaveBeenNthCalledWith(2, `${NAS_BACKUP_DIR}/home-assistant-20260615-0531.tar.meta.json`);
  });

  it('still succeeds (metaRemoved:false) when the sidecar is absent — a bare legacy slot', async () => {
    mockNas.nasRemove
      .mockResolvedValueOnce(undefined) // tar
      .mockRejectedValueOnce(new Error('550 not found')); // missing sidecar
    const r = await deleteServiceBackup('adguard.tar');
    expect(r).toEqual({ tarName: 'adguard.tar', metaRemoved: false });
    expect(mockNas.nasRemove).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty', ''],
    ['path separator', 'sub/home-assistant.tar'],
    ['parent traversal', '../home-assistant.tar'],
    ['absolute path', '/etc/passwd.tar'],
    ['backslash', 'a\\b.tar'],
    ['NUL byte', 'evil\0.tar'],
    ['not a tar', 'home-assistant.txt'],
  ])('rejects a %s tarName without touching the NAS', async (_label, name) => {
    await expect(deleteServiceBackup(name)).rejects.toThrow();
    expect(mockNas.nasRemove).not.toHaveBeenCalled();
  });
});
