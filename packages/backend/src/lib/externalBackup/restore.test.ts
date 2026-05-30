import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockCfg } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);

import { restoreServiceBackup, isFreshDataDir } from './restore';
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
  dataDir = path.join(tmpRoot, 'home-assistant');
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

    const res = await restoreServiceBackup('home-assistant');
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

    await expect(restoreServiceBackup('home-assistant')).rejects.toThrow(/already has data/);
    expect(await fs.readFile(path.join(dataDir, 'existing.yaml'), 'utf8')).toBe('live'); // untouched
  });

  it('overwrites a populated data dir when force is set', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'old');
    serveTar(await buildServiceTar({ 'configuration.yaml': 'new' }));

    const res = await restoreServiceBackup('home-assistant', { force: true });
    expect(res.files).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('new');
  });

  it('rejects a service with no backup manifest', async () => {
    await expect(restoreServiceBackup('not-a-service')).rejects.toThrow(/No backup manifest/);
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
