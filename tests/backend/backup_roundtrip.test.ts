/**
 * Backup round-trip integration test (#2154).
 *
 * The #1584 lesson — "the restore mechanism fired, the payload was empty, nobody
 * noticed" — was never encoded as a test. This exercises the FULL cycle against
 * REAL code, per manifest-covered service shape:
 *
 *   seed fixtures matching the manifest include-set
 *     → produce the tar   (backup-worker `buildServiceBackupTar` — the real staging path)
 *     → wipe the data dir  (rm -rf, simulating a disk-loss reinstall)
 *     → restore            (`safeTarExtract` — the real #580-hardened restore path)
 *     → assert every included file's CONTENT round-tripped
 *     → assert `strip` rules removed the secrets
 *
 * Crucially it FAILS on silent path drift: if a manifest `include` entry stops
 * matching a real seeded file, `buildServiceBackupTar` stages nothing and throws
 * "No config files to back up" — exactly the drift #2154 asks us to catch (e.g.
 * the old authelia `users_database.yml` mismatch).
 *
 * Requires GNU tar on $PATH (same as backup_restore_security.test.ts); skipped
 * automatically if absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildServiceBackupTar } from '../../packages/backup-worker/src/engine/staging';
import { getServiceManifest } from '../../packages/backup-worker/src/engine/serviceManifest';
import { safeTarExtract } from '@/lib/systemBackup';

function tarPresent(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const maybeIt = tarPresent() ? it : it.skip;

let tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-roundtrip-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
async function write(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
async function read(base: string, rel: string): Promise<string> {
  return fs.readFile(path.join(base, rel), 'utf8');
}

beforeEach(() => { tmpDirs = []; });
afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
});

/**
 * Run one full backup→wipe→restore cycle for a service and return the restored
 * data dir. `seed` writes the fixtures; the tar is built from `src` (which is
 * then wiped), and extracted into a fresh dir.
 */
async function roundTrip(
  service: string,
  seed: (src: string) => Promise<void>,
): Promise<string> {
  const manifest = getServiceManifest(service)!;
  expect(manifest, `manifest for ${service} must exist`).toBeDefined();
  const src = await mkTmp(`${service}-src`);
  await seed(src);

  const tarDir = await mkTmp(`${service}-tar`);
  const tarPath = path.join(tarDir, `${service}.tar`);
  const { files } = await buildServiceBackupTar(src, manifest, tarPath);
  expect(files, 'the manifest include-set must match seeded files (path-drift guard)').toBeGreaterThan(0);

  // Wipe — the disk-loss reinstall.
  await fs.rm(src, { recursive: true, force: true });

  // Restore through the real hardened extract path. buildServiceBackupTar makes
  // a plain (non-gzip) tar, so gzip:false.
  const restored = await mkTmp(`${service}-restored`);
  await safeTarExtract(tarPath, restored, { gzip: false });
  return restored;
}

describe('backup round-trip (#2154) — content survives backup→wipe→restore', () => {
  maybeIt('adguard: config content round-trips, querylog is not backed up', async () => {
    const restored = await roundTrip('adguard', async src => {
      await write(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0\nusers:\n  - name: admin\n');
      await write(src, 'data/querylog.json', '[{"secret":"log"}]'); // excluded
    });
    expect(await read(restored, 'conf/AdGuardHome.yaml')).toContain('bind_host: 0.0.0.0');
    // The excluded bulk file never entered the tarball.
    await expect(fs.access(path.join(restored, 'data/querylog.json'))).rejects.toThrow();
  });

  maybeIt('lldap: users.db identity store round-trips verbatim (#2153)', async () => {
    const restored = await roundTrip('lldap', async src => {
      await write(src, 'users.db', 'SQLITE-IDENTITY-BYTES');
    });
    expect(await read(restored, 'users.db')).toBe('SQLITE-IDENTITY-BYTES');
  });

  maybeIt('vaultwarden: vault db + JWT keys round-trip, attachments excluded (#2153)', async () => {
    const restored = await roundTrip('vaultwarden', async src => {
      await write(src, 'db.sqlite3', 'VAULT-CIPHERTEXT');
      await write(src, 'rsa_key.pem', 'PRIVATE-JWT-KEY');
      await write(src, 'config.json', '{"domain":"vault.dopp.cloud"}');
      await write(src, 'attachments/big.bin', 'HEAVY-USER-DATA'); // excluded/data
    });
    expect(await read(restored, 'db.sqlite3')).toBe('VAULT-CIPHERTEXT');
    expect(await read(restored, 'rsa_key.pem')).toBe('PRIVATE-JWT-KEY');
    expect(await read(restored, 'config.json')).toContain('vault.dopp.cloud');
    await expect(fs.access(path.join(restored, 'attachments/big.bin'))).rejects.toThrow();
  });

  maybeIt('radicale: calendar/contact collections round-trip (#2153)', async () => {
    const restored = await roundTrip('radicale', async src => {
      await write(src, 'collections/collection-root/user/calendar.ics', 'BEGIN:VCALENDAR');
    });
    expect(await read(restored, 'collections/collection-root/user/calendar.ics')).toBe('BEGIN:VCALENDAR');
  });

  maybeIt('jellyfin: server config + db round-trip, caches/metadata excluded (#2153)', async () => {
    const restored = await roundTrip('jellyfin', async src => {
      await write(src, 'config/system.xml', '<ServerConfiguration/>');
      await write(src, 'data/jellyfin.db', 'JELLYFIN-USERS-DB');
      await write(src, 'metadata/artwork/poster.jpg', 'BULK-ARTWORK'); // excluded
      await write(src, 'cache/temp', 'REGENERABLE'); // excluded
    });
    expect(await read(restored, 'config/system.xml')).toContain('ServerConfiguration');
    expect(await read(restored, 'data/jellyfin.db')).toBe('JELLYFIN-USERS-DB');
    await expect(fs.access(path.join(restored, 'metadata/artwork/poster.jpg'))).rejects.toThrow();
    await expect(fs.access(path.join(restored, 'cache/temp'))).rejects.toThrow();
  });

  maybeIt('file-share: samba passdb + filebrowser config round-trip (#2153)', async () => {
    const restored = await roundTrip('file-share', async src => {
      await write(src, 'samba-private/passdb.tdb', 'SAMBA-ACCOUNTS');
      await write(src, 'filebrowser-db/filebrowser.db', 'FB-USERS');
      await write(src, 'filebrowser-config/settings.json', '{"port":80}');
    });
    expect(await read(restored, 'samba-private/passdb.tdb')).toBe('SAMBA-ACCOUNTS');
    expect(await read(restored, 'filebrowser-db/filebrowser.db')).toBe('FB-USERS');
    expect(await read(restored, 'filebrowser-config/settings.json')).toContain('"port":80');
  });

  maybeIt('authelia: db.sqlite3 secret store round-trips, legacy YAML is gone (#2153)', async () => {
    const restored = await roundTrip('authelia', async src => {
      await write(src, 'db.sqlite3', 'TOTP-WEBAUTHN-SECRETS');
      // The legacy file-backend YAML is no longer in the include-set — seeding
      // it must NOT make it into the tar (it's dead state).
      await write(src, 'users_database.yml', 'users:\n  a:\n    password: LEGACY\n');
    });
    expect(await read(restored, 'db.sqlite3')).toBe('TOTP-WEBAUTHN-SECRETS');
    await expect(fs.access(path.join(restored, 'users_database.yml'))).rejects.toThrow();
  });

  maybeIt('hermes: strip removes LLM api keys before the tar (secret never lands)', async () => {
    const restored = await roundTrip('hermes', async src => {
      await write(src, 'config.yaml', 'api_key: SUPER-SECRET-KEY\nmodel: gemma-e4b\n');
    });
    const cfg = await read(restored, 'config.yaml');
    // The strip rule removed the secret but kept the rest of the config.
    expect(cfg).not.toContain('SUPER-SECRET-KEY');
    expect(cfg).toContain('gemma-e4b');
  });

  maybeIt('path-drift guard: a manifest include that matches nothing fails the round-trip', async () => {
    // Seed a file that does NOT match any include (mimics a manifest path that
    // silently stopped matching real template paths). buildServiceBackupTar must
    // throw rather than ship an empty backup unnoticed.
    await expect(
      roundTrip('lldap', async src => {
        await write(src, 'wrong-name.db', 'ORPHANED');
      }),
    ).rejects.toThrow(/No config files/);
  });
});
