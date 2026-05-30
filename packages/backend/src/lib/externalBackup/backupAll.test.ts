import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { mockNas, mockCfg } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);

import { backupInstalledServicesToNas } from './producer';

let tmpRoot: string;

async function write(rel: string, content: string) {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockNas.nasUpload.mockResolvedValue(undefined);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'backupall-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('backupInstalledServicesToNas', () => {
  it('backs up only installed manifest services, skipping the rest', async () => {
    // adguard is installed (with a manifest config file); home-assistant is NOT.
    await write('adguard/conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    mockCfg.getConfig.mockResolvedValue({
      templateSettings: { DATA_DIR: tmpRoot },
      installedTemplates: { adguard: { schemaVersion: 1, installedAt: 'x' } },
    });

    const results = await backupInstalledServicesToNas();

    // Only adguard ran; home-assistant/authelia/etc. are not installed → not attempted.
    expect(results.map(r => r.service)).toEqual(['adguard']);
    expect(results[0]).toMatchObject({ service: 'adguard', ok: true, tarName: 'adguard.tar' });
    // The tar + meta were uploaded to the NAS.
    const uploaded = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploaded).toContain('sb-backup/adguard.tar');
  });

  it('captures a per-service failure without aborting the run', async () => {
    // adguard installed but its data dir is missing its config → produces no
    // files → backupServiceToNas throws; the run records it as ok:false.
    mockCfg.getConfig.mockResolvedValue({
      templateSettings: { DATA_DIR: tmpRoot },
      installedTemplates: { adguard: { schemaVersion: 1, installedAt: 'x' } },
    });

    const results = await backupInstalledServicesToNas();
    expect(results).toHaveLength(1);
    expect(results[0].service).toBe('adguard');
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBeTruthy();
  });

  it('returns empty when nothing with a manifest is installed', async () => {
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: { 'some-unmanaged-thing': {} } });
    expect(await backupInstalledServicesToNas()).toEqual([]);
  });
});
