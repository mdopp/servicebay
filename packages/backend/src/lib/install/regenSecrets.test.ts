/**
 * regenSecrets — in-process regeneration of the two boot-critical key
 * files after a stack reset wipes them (#1246).
 *
 * Covers the acceptance criteria:
 *  (a) wipe-and-regen writes BOTH secret.key and .auth-secret.env, in the
 *      exact formats the boot init units produce;
 *  (b) the in-memory key cache is invalidated so the next encrypt() uses
 *      the freshly-written key (the one a rebooted container would load).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// dirs.ts reads DATA_DIR at module load, so point it at a temp dir
// BEFORE importing anything that transitively pulls it in.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-regen-'));
process.env.DATA_DIR = TMP_DATA_DIR;

const { regenerateWipedKeys, regenerateAuthSecretEnv, regenerateWipedKeysUnlessPreservedConfig } =
  await import('./regenSecrets');
const secrets = await import('@/lib/secrets');

const SECRET_KEY_PATH = path.join(TMP_DATA_DIR, 'secret.key');
const AUTH_SECRET_ENV_PATH = path.join(TMP_DATA_DIR, '.auth-secret.env');
const CONFIG_PATH = path.join(TMP_DATA_DIR, 'config.json');

function wipeKeyFiles() {
  for (const p of [SECRET_KEY_PATH, AUTH_SECRET_ENV_PATH, CONFIG_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

beforeEach(() => {
  wipeKeyFiles();
  secrets.resetCachedKey();
});

afterAll(() => {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

describe('regenerateWipedKeys', () => {
  it('writes both secret.key and .auth-secret.env after a wipe', () => {
    expect(fs.existsSync(SECRET_KEY_PATH)).toBe(false);
    expect(fs.existsSync(AUTH_SECRET_ENV_PATH)).toBe(false);

    const result = regenerateWipedKeys();

    expect(result.secretKeyPath).toBe(SECRET_KEY_PATH);
    expect(result.authSecretEnvPath).toBe(AUTH_SECRET_ENV_PATH);
    expect(fs.existsSync(SECRET_KEY_PATH)).toBe(true);
    expect(fs.existsSync(AUTH_SECRET_ENV_PATH)).toBe(true);
  });

  it('writes a 32-byte raw secret.key (matches aes-256-gcm / the boot init)', () => {
    regenerateWipedKeys();
    const key = fs.readFileSync(SECRET_KEY_PATH);
    expect(key.length).toBe(32);
  });

  it('writes .auth-secret.env as AUTH_SECRET=<64 hex chars> (>= 32-char floor)', () => {
    regenerateWipedKeys();
    const content = fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8');
    const m = content.match(/^AUTH_SECRET=([0-9a-f]+)\n$/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBe(64); // 32 bytes hex-encoded
    expect(m![1].length).toBeGreaterThanOrEqual(32); // assertAuthSecret() floor
  });

  it('writes both files mode 0600', () => {
    regenerateWipedKeys();
    expect(fs.statSync(SECRET_KEY_PATH).mode & 0o777).toBe(0o600);
    expect(fs.statSync(AUTH_SECRET_ENV_PATH).mode & 0o777).toBe(0o600);
  });

  it('generates fresh, distinct values each run', () => {
    regenerateWipedKeys();
    const key1 = fs.readFileSync(SECRET_KEY_PATH);
    const auth1 = fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8');
    wipeKeyFiles();
    regenerateWipedKeys();
    const key2 = fs.readFileSync(SECRET_KEY_PATH);
    const auth2 = fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8');
    expect(key2.equals(key1)).toBe(false);
    expect(auth2).not.toBe(auth1);
  });

  it('invalidates the cached key so the next encrypt() uses the new key', () => {
    // Seal a value under an initial key.
    const sealed = secrets.encrypt('hunter2');
    expect(secrets.decrypt(sealed)).toBe('hunter2');

    // Reset wipes + regenerates the key in-process.
    regenerateWipedKeys();

    // A value encrypted under the OLD key can no longer be decrypted
    // (GCM auth-tag mismatch → empty string), proving the cache flipped
    // to the new on-disk key rather than reusing the old in-memory one.
    expect(secrets.decrypt(sealed)).toBe('');

    // Round-trip under the new key works.
    const reSealed = secrets.encrypt('hunter3');
    expect(secrets.decrypt(reSealed)).toBe('hunter3');

    // And the new ciphertext really is keyed differently from the old.
    expect(reSealed).not.toBe(sealed);
  });
});

describe('regenerateWipedKeysUnlessPreservedConfig (#1667)', () => {
  it('PRESERVES the existing keys verbatim when config.json carries enc: values', () => {
    // Establish a key + seal a value under it; capture the on-disk bytes.
    const sealed = secrets.encrypt('gateway-password');
    const keyBefore = fs.readFileSync(SECRET_KEY_PATH);
    // Write the auth secret + a config.json that carries an enc: value.
    regenerateAuthSecretEnv();
    const authBefore = fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { password: sealed } }));

    const result = regenerateWipedKeysUnlessPreservedConfig();

    expect(result.preserved).toBe(true);
    // Keys untouched — same bytes, so the preserved enc: value still decrypts.
    expect(fs.readFileSync(SECRET_KEY_PATH).equals(keyBefore)).toBe(true);
    expect(fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8')).toBe(authBefore);
    expect(secrets.decrypt(sealed)).toBe('gateway-password');
  });

  it('GENERATES fresh keys on a genuinely-fresh box (no config.json)', () => {
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);
    const result = regenerateWipedKeysUnlessPreservedConfig();
    expect(result.preserved).toBe(false);
    expect(fs.existsSync(SECRET_KEY_PATH)).toBe(true);
    expect(fs.existsSync(AUTH_SECRET_ENV_PATH)).toBe(true);
  });

  it('GENERATES fresh keys when config.json exists but has no enc: values', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ serverName: 'OSCAR', publicDomain: 'x.com' }));
    const result = regenerateWipedKeysUnlessPreservedConfig();
    expect(result.preserved).toBe(false);
    expect(fs.existsSync(SECRET_KEY_PATH)).toBe(true);
    expect(fs.existsSync(AUTH_SECRET_ENV_PATH)).toBe(true);
  });

  it('does NOT mint a fresh key over preserved ciphertext when a key file is missing', () => {
    // enc: config present but secret.key absent: minting would orphan it.
    const sealed = secrets.encrypt('secret-value'); // writes secret.key
    regenerateAuthSecretEnv();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ a: sealed }));
    fs.unlinkSync(SECRET_KEY_PATH); // simulate a half-present identity

    const result = regenerateWipedKeysUnlessPreservedConfig();

    expect(result.preserved).toBe(true);
    // It must NOT have generated a new secret.key.
    expect(fs.existsSync(SECRET_KEY_PATH)).toBe(false);
  });
});

describe('regenerateAuthSecretEnv', () => {
  it('overwrites an existing .auth-secret.env (idempotent after wipe-replace)', () => {
    fs.writeFileSync(AUTH_SECRET_ENV_PATH, 'AUTH_SECRET=stale\n');
    regenerateAuthSecretEnv();
    const content = fs.readFileSync(AUTH_SECRET_ENV_PATH, 'utf8');
    expect(content).not.toContain('stale');
    expect(content).toMatch(/^AUTH_SECRET=[0-9a-f]{64}\n$/);
  });
});
