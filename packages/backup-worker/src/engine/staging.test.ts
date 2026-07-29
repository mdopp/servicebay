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

  it('applies strip rules (secrets never enter the tar)', async () => {
    // hermes strips LLM api keys from config.yaml before it enters the tarball.
    const src = await mkTmp();
    await write(src, 'config.yaml', 'api_key: SEKRIT\nmodel: gemma-e4b\n');
    const staging = await mkTmp();

    await stageServiceBackup(src, getServiceManifest('hermes')!, staging);

    const out = await fs.readFile(path.join(staging, 'config.yaml'), 'utf8');
    expect(out).not.toContain('SEKRIT');
    expect(out).toContain('gemma-e4b');
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

  // #2454 — a compromised service must not be able to point one of its own
  // manifest includes at a SIBLING service's data dir and have the worker copy
  // that sibling's bytes into its own (offsite-shipped) tar.
  describe('symlink escape (#2454)', () => {
    it('skips an include that is a symlink at a sibling service data dir', async () => {
      const victim = await mkTmp();
      await write(victim, 'secrets.json', 'SIBLING-SECRET');
      const src = await mkTmp();
      await write(src, 'configuration.yaml', 'default_config:');
      await fs.symlink(victim, path.join(src, '.storage')); // hostile swap
      const staging = await mkTmp();

      const manifest: ServiceBackupManifest = {
        service: 'home-assistant',
        include: ['configuration.yaml', '.storage'],
        exclude: [],
      };
      const staged = await stageServiceBackup(src, manifest, staging);

      expect(staged).toEqual(['configuration.yaml']);
      expect(staged.some(p => p.startsWith('.storage'))).toBe(false);
      await expect(fs.access(path.join(staging, '.storage'))).rejects.toThrow();
      await expect(fs.access(path.join(staging, 'secrets.json'))).rejects.toThrow();
    });

    it('skips a single-file include symlinked outside the data root', async () => {
      const victim = await mkTmp();
      await write(victim, 'config.yaml', 'api_key: SIBLING-SECRET\n');
      const src = await mkTmp();
      await fs.symlink(path.join(victim, 'config.yaml'), path.join(src, 'config.yaml'));
      const staging = await mkTmp();

      const staged = await stageServiceBackup(src, getServiceManifest('hermes')!, staging);

      expect(staged).toEqual([]);
      await expect(fs.access(path.join(staging, 'config.yaml'))).rejects.toThrow();
    });

    it('does not enumerate or stage a glob include whose parent escapes the data root', async () => {
      const victim = await mkTmp();
      await write(victim, 'lovelace.lovelace', 'SIBLING-DASHBOARD');
      const src = await mkTmp();
      await write(src, 'configuration.yaml', 'default_config:');
      await fs.symlink(victim, path.join(src, '.storage'));
      const staging = await mkTmp();

      const staged = await stageServiceBackup(src, getServiceManifest('home-assistant')!, staging);

      expect(staged).not.toContain('.storage/lovelace.lovelace');
      expect(staged).toContain('configuration.yaml');
    });

    it('does not follow a symlink nested inside an included directory', async () => {
      const victim = await mkTmp();
      await write(victim, 'querylog.json', 'SIBLING-DATA');
      const src = await mkTmp();
      await write(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
      await fs.symlink(path.join(victim, 'querylog.json'), path.join(src, 'conf/leak.json'));
      await fs.symlink(victim, path.join(src, 'conf/leakdir'));
      const staging = await mkTmp();

      const staged = await stageServiceBackup(src, getServiceManifest('adguard')!, staging);

      expect(staged).toEqual(['conf/AdGuardHome.yaml']);
    });

    it('still stages a symlink that stays inside the service data root', async () => {
      const src = await mkTmp();
      await write(src, 'real-storage/lovelace.lovelace', 'MY-DASH');
      await write(src, 'configuration.yaml', 'default_config:');
      await fs.symlink(path.join(src, 'real-storage'), path.join(src, '.storage'));
      const staging = await mkTmp();

      const staged = await stageServiceBackup(src, getServiceManifest('home-assistant')!, staging);

      expect(staged).toContain('.storage/lovelace.lovelace');
      expect(staged).toContain('configuration.yaml');
      await expect(
        fs.readFile(path.join(staging, '.storage/lovelace.lovelace'), 'utf8'),
      ).resolves.toBe('MY-DASH');
    });

    it('skips an include that climbs out with ..', async () => {
      const parent = await mkTmp();
      await write(parent, 'outside.yaml', 'SIBLING-SECRET');
      const src = path.join(parent, 'service');
      await fs.mkdir(src, { recursive: true });
      const staging = await mkTmp();

      const manifest: ServiceBackupManifest = {
        service: 'evil',
        include: ['../outside.yaml'],
        exclude: [],
      };

      expect(await stageServiceBackup(src, manifest, staging)).toEqual([]);
    });
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
