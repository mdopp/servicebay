import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn(), nasRemove: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);
// writeServiceBackupToNas reads externalBackup.retention from config (#1865).
vi.mock('../config', () => ({ getConfig: vi.fn(async () => ({})) }));

import { extractHaConfigDir, importHaOsBackupToNas } from './haOsImport';

let tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'haimport-test-'));
  tmpDirs.push(d);
  return d;
}
async function write(base: string, rel: string, content: string) {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Build a minimal Home Assistant Supervisor backup tar: an outer tar holding
 * backup.json + homeassistant.tar.gz, where the inner archive has the config
 * under data/ (the real layout). Returns the outer tar path.
 */
async function buildFakeHaBackup(): Promise<string> {
  const innerStage = await mkTmp();
  await write(innerStage, 'homeassistant.json', '{"version":"2026.4.4"}');
  await write(innerStage, 'data/configuration.yaml', 'default_config:');
  await write(innerStage, 'data/.storage/zwave_js', '{"keys":"SECRET-MESH"}');
  await write(innerStage, 'data/.storage/core.entity_registry', '{}');
  // Glob-matched members (#1595/#1596): a dashboard + HACS data.
  await write(innerStage, 'data/.storage/lovelace.lovelace', '{"dash":"main"}');
  await write(innerStage, 'data/.storage/hacs.repositories', '{"repos":[]}');
  await write(innerStage, 'data/home-assistant_v2.db', 'BINARYDB'); // manifest-excluded
  await write(innerStage, 'data/home-assistant.log', 'noise');       // manifest-excluded

  const outerStage = await mkTmp();
  await execFileAsync('tar', ['-czf', path.join(outerStage, 'homeassistant.tar.gz'), '-C', innerStage, '.']);
  await fs.writeFile(path.join(outerStage, 'backup.json'), '{"version":2,"type":"partial"}');

  const out = await mkTmp();
  const tarPath = path.join(out, 'ha-backup.tar');
  await execFileAsync('tar', ['-cf', tarPath, '-C', outerStage, 'homeassistant.tar.gz', 'backup.json']);
  return tarPath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNas.nasUpload.mockResolvedValue(undefined);
  // #1865 — the producer prunes after writing (lists then removes); empty NAS.
  mockNas.nasList.mockResolvedValue([]);
  mockNas.nasRemove.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

const HA_INCLUDES = [
  'configuration.yaml', '.storage/zwave_js', '.storage/core.entity_registry',
  '.storage/lovelace*', '.storage/hacs*',
];

describe('extractHaConfigDir', () => {
  it('extracts only the requested include paths from the inner data/ dir', async () => {
    const backup = await buildFakeHaBackup();
    const work = await mkTmp();
    const dataDir = await extractHaConfigDir(backup, work, HA_INCLUDES);
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('default_config:');
    expect(await exists(path.join(dataDir, '.storage/zwave_js'))).toBe(true);
    // Glob includes pull the dashboard + HACS data members (#1595/#1596).
    expect(await exists(path.join(dataDir, '.storage/lovelace.lovelace'))).toBe(true);
    expect(await exists(path.join(dataDir, '.storage/hacs.repositories'))).toBe(true);
    // The big excluded members are never even unpacked to /tmp (#1353): the
    // whole point is to not write the DB out and exhaust the container tmpfs.
    expect(await exists(path.join(dataDir, 'home-assistant_v2.db'))).toBe(false);
    expect(await exists(path.join(dataDir, 'home-assistant.log'))).toBe(false);
  });

  it('rejects a tar that is not an HA backup', async () => {
    const dir = await mkTmp();
    await write(dir, 'random.txt', 'x');
    const notHa = path.join(dir, 'not-ha.tar');
    await execFileAsync('tar', ['-cf', notHa, '-C', dir, 'random.txt']);
    await expect(extractHaConfigDir(notHa, await mkTmp(), HA_INCLUDES)).rejects.toThrow(/Home Assistant/);
  });

  it('rejects an HA archive with no recognised config files', async () => {
    const innerStage = await mkTmp();
    await write(innerStage, 'data/home-assistant_v2.db', 'DB'); // present but not an include
    const outerStage = await mkTmp();
    await execFileAsync('tar', ['-czf', path.join(outerStage, 'homeassistant.tar.gz'), '-C', innerStage, '.']);
    const out = await mkTmp();
    const tarPath = path.join(out, 'ha.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', outerStage, 'homeassistant.tar.gz']);
    await expect(extractHaConfigDir(tarPath, await mkTmp(), HA_INCLUDES)).rejects.toThrow(/no recognised config/);
  });
});

describe('importHaOsBackupToNas', () => {
  it('stages a manifest-filtered home-assistant.tar (config + zwave_js, no DB) to the NAS', async () => {
    const backup = await buildFakeHaBackup();
    const res = await importHaOsBackupToNas(backup);
    expect(res.tarName).toMatch(/^home-assistant-\d{8}-\d{4}\.tar$/); // dated slot (#1865)

    const tarCall = mockNas.nasUpload.mock.calls.find(c => /\/home-assistant-\d{8}-\d{4}\.tar$/.test(String(c[0])))!;
    expect(tarCall).toBeTruthy();

    // Extract the staged tar and check the manifest filter was applied.
    const out = await mkTmp();
    const tarFile = path.join(out, 'staged.tar');
    await fs.writeFile(tarFile, tarCall[1] as Buffer);
    const extracted = await mkTmp();
    await execFileAsync('tar', ['-xf', tarFile, '-C', extracted]);
    expect(await exists(path.join(extracted, 'configuration.yaml'))).toBe(true);
    expect(await exists(path.join(extracted, '.storage/zwave_js'))).toBe(true);
    expect(await exists(path.join(extracted, 'home-assistant_v2.db'))).toBe(false); // excluded
    expect(await exists(path.join(extracted, 'home-assistant.log'))).toBe(false);   // excluded
  });
});
