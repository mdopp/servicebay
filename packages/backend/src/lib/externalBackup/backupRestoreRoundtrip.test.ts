import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// End-to-end backup → restore round-trip (#1218 entry 1 / epic #1190): the real
// producer writes a service tar, the real restore path reads it back, and we
// assert the manifest's include/exclude/strip rules survive the trip. This is
// the unit-level backstop for the deferred on-box reinstall verify — if the
// producer's tar layout and the restore's extraction ever drift, this fails.
// Only the NAS transport is mocked (an in-memory store); everything between is
// the production code path.
const { mockNas, mockCfg } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);

import { backupServiceToNas, NAS_BACKUP_DIR } from './producer';
import { restoreServiceBackup } from './restore';

let nas: Map<string, Buffer>;
let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  nas = new Map();
  mockNas.nasUpload.mockImplementation(async (p: string, data: Buffer) => { nas.set(p, Buffer.from(data)); });
  mockNas.nasDownload.mockImplementation(async (p: string) => {
    const b = nas.get(p);
    if (!b) throw new Error(`NAS 404: ${p}`);
    return b;
  });
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'roundtrip-'));
  mockCfg.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: tmpRoot } });
});
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe('backup → restore round-trip (#1218 / #1190)', () => {
  it('home-assistant: restores config + zwave mesh keys, drops the recorder DB and bulk data', async () => {
    const src = path.join(tmpRoot, 'src-home-assistant');
    await writeFiles(src, {
      'configuration.yaml': 'default_config:\n',
      'automations.yaml': '- alias: front door\n',
      '.storage/zwave_js': '{"network_keys":"MESH-SECRET"}', // MUST survive — recovers the Z-Wave mesh
      'home-assistant_v2.db': 'SQLITE-RECORDER-BLOB',         // excluded (bulk history)
      'home-assistant.log': 'noise',                          // excluded
      'www/photo.jpg': 'BINARY',                              // excluded dir
    });

    await backupServiceToNas('home-assistant', { serviceDataDir: src });
    expect(nas.has(`${NAS_BACKUP_DIR}/home-assistant.tar`)).toBe(true);

    const { dataDir } = await restoreServiceBackup('home-assistant', { local: true });

    // kept config — including the zwave network keys the operator can't reconstruct
    expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('default_config:\n');
    expect(await fs.readFile(path.join(dataDir, 'automations.yaml'), 'utf8')).toBe('- alias: front door\n');
    expect(await fs.readFile(path.join(dataDir, '.storage/zwave_js'), 'utf8')).toBe('{"network_keys":"MESH-SECRET"}');
    // dropped — never backed up, so never restored
    expect(await exists(path.join(dataDir, 'home-assistant_v2.db'))).toBe(false);
    expect(await exists(path.join(dataDir, 'home-assistant.log'))).toBe(false);
    expect(await exists(path.join(dataDir, 'www'))).toBe(false);
  });

  it('authelia: round-trips usernames + email but strips password hashes', async () => {
    const src = path.join(tmpRoot, 'src-authelia');
    await writeFiles(src, {
      'users_database.yml': [
        'users:',
        '  alice:',
        '    displayname: Alice',
        '    email: alice@dopp.cloud',
        '    password: $argon2id$SECRET-HASH',
        '',
      ].join('\n'),
    });

    await backupServiceToNas('authelia', { serviceDataDir: src });
    const { dataDir } = await restoreServiceBackup('authelia', { local: true });
    const restored = await fs.readFile(path.join(dataDir, 'users_database.yml'), 'utf8');

    expect(restored).toContain('alice');
    expect(restored).toContain('alice@dopp.cloud');
    expect(restored).not.toContain('SECRET-HASH'); // password stripped before it ever reaches the NAS
  });

  it('survives a wipe-then-reinstall: a populated source restores cleanly into the emptied data dir', async () => {
    const src = path.join(tmpRoot, 'src-adguard');
    await writeFiles(src, {
      'conf/AdGuardHome.yaml': 'dns:\n  rewrites:\n    - domain: home.dopp.cloud\n',
      'data/querylog.json': '["bulk"]', // excluded
    });
    await backupServiceToNas('adguard', { serviceDataDir: src });

    // Simulate the reinstall wiping the live data dir to empty, then restoring.
    const dest = path.join(tmpRoot, 'adguard');
    await fs.mkdir(dest, { recursive: true }); // empty dir is the fresh/seedable state
    const { files } = await restoreServiceBackup('adguard', { local: true });

    expect(files).toBe(1); // only the included config, not the querylog
    expect(await fs.readFile(path.join(dest, 'conf/AdGuardHome.yaml'), 'utf8')).toContain('home.dopp.cloud');
    expect(await exists(path.join(dest, 'data/querylog.json'))).toBe(false);
  });
});
