import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockGetConfig } = vi.hoisted(() => ({
  mockNas: {
    nasUpload: vi.fn(),
    nasDownload: vi.fn(),
    nasList: vi.fn(),
  },
  mockGetConfig: vi.fn(),
}));

vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import {
  stageServiceBackup,
  buildServiceBackupTar,
  backupServiceToNas,
  resolveServiceDataDir,
  listServiceBackups,
  fetchServiceBackup,
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

  it('resolves the data dir from config when serviceDataDir is omitted', async () => {
    const stacks = await mkTmp();
    await writeFile(stacks, 'adguard/conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: stacks } });

    const result = await backupServiceToNas('adguard');
    expect(result.size).toBeGreaterThan(0);
  });
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
