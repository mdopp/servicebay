import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { stageServiceBackup, buildServiceBackupTar } from './staging';
import { getServiceManifest, type ServiceBackupManifest } from './serviceManifest';

const execFileAsync = promisify(execFile);

let tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bw-stage-'));
  tmpDirs.push(dir);
  return dir;
}

async function write(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(() => { tmpDirs = []; });
afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
});

describe('stageServiceBackup', () => {
  it('stages includes and skips excludes', async () => {
    const src = await mkTmp();
    await write(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    await write(src, 'data/querylog.json', '[]'); // excluded
    const staging = await mkTmp();

    const staged = await stageServiceBackup(src, getServiceManifest('adguard')!, staging);

    expect(staged).toEqual(['conf/AdGuardHome.yaml']);
    await expect(fs.readFile(path.join(staging, 'conf/AdGuardHome.yaml'), 'utf8')).resolves.toBe('bind_host: 0.0.0.0');
    await expect(fs.access(path.join(staging, 'data/querylog.json'))).rejects.toThrow();
  });

  it('expands a trailing-* glob include (HA dashboards)', async () => {
    const src = await mkTmp();
    await write(src, '.storage/lovelace.lovelace', 'dash');
    await write(src, '.storage/lovelace_dashboards', 'list');
    await write(src, 'configuration.yaml', 'default_config:');
    const staging = await mkTmp();

    const staged = await stageServiceBackup(src, getServiceManifest('home-assistant')!, staging);

    expect(staged).toContain('.storage/lovelace.lovelace');
    expect(staged).toContain('.storage/lovelace_dashboards');
    expect(staged).toContain('configuration.yaml');
  });

  it('applies strip rules (password hashes never enter the tar)', async () => {
    const src = await mkTmp();
    await write(src, 'users_database.yml', 'users:\n  a:\n    password: $argon2$SEKRIT\n    email: a@x\n');
    const staging = await mkTmp();

    await stageServiceBackup(src, getServiceManifest('authelia')!, staging);

    const out = await fs.readFile(path.join(staging, 'users_database.yml'), 'utf8');
    expect(out).not.toContain('SEKRIT');
    expect(out).toContain('a@x');
  });

  it('stages a renamed source path under its canonical tar name', async () => {
    const src = await mkTmp();
    await write(src, 'data/database.sqlite.sb-backup', 'SNAPSHOT');
    const staging = await mkTmp();
    const manifest: ServiceBackupManifest = {
      service: 'nginx',
      include: ['data/database.sqlite.sb-backup'],
      exclude: [],
      renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
    };

    const staged = await stageServiceBackup(src, manifest, staging);

    expect(staged).toEqual(['data/database.sqlite']);
    await expect(fs.readFile(path.join(staging, 'data/database.sqlite'), 'utf8')).resolves.toBe('SNAPSHOT');
  });

  it('returns [] when nothing matches', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    expect(await stageServiceBackup(src, getServiceManifest('adguard')!, staging)).toEqual([]);
  });
});

describe('buildServiceBackupTar', () => {
  it('produces a tar holding the staged config', async () => {
    const src = await mkTmp();
    await write(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    const out = await mkTmp();
    const tarPath = path.join(out, 'adguard.tar');

    const { files, bytes } = await buildServiceBackupTar(src, getServiceManifest('adguard')!, tarPath);

    expect(files).toBe(1);
    expect(bytes).toBeGreaterThan(0);
    const extracted = await mkTmp();
    await execFileAsync('tar', ['-xf', tarPath, '-C', extracted]);
    await expect(fs.readFile(path.join(extracted, 'conf/AdGuardHome.yaml'), 'utf8')).resolves.toBe('bind_host: 0.0.0.0');
  });

  it('throws "No config files to back up" when nothing matched', async () => {
    const src = await mkTmp();
    const out = await mkTmp();
    await expect(
      buildServiceBackupTar(src, getServiceManifest('adguard')!, path.join(out, 'x.tar')),
    ).rejects.toThrow(/No config files/);
  });
});
