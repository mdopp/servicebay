// src/lib/secrets.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './dirs';
import { logger } from './logger';

const SECRET_KEY_PATH = path.join(DATA_DIR, 'secret.key');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

// Ensure secret key exists
function getSecretKey(): Buffer {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(SECRET_KEY_PATH)) {
    const key = crypto.randomBytes(32); // 256 bits
    fs.writeFileSync(SECRET_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  return fs.readFileSync(SECRET_KEY_PATH);
}

// Global cached key (loaded on first use)
let CACHED_KEY: Buffer | null = null;

function getKey(): Buffer {
  if (!CACHED_KEY) {
    CACHED_KEY = getSecretKey();
  }
  return CACHED_KEY;
}

/**
 * Invalidate the in-memory key cache so the next `encrypt`/`decrypt`
 * re-reads `secret.key` from disk. Used by the stack-reset engine after
 * it regenerates the key file in-process — without this, the running
 * container keeps encrypting with the wiped-then-regenerated key's
 * predecessor held in `CACHED_KEY`, so values sealed after the reset
 * couldn't be decrypted by a freshly-booted container reading the new
 * on-disk key. See #1246.
 */
export function resetCachedKey(): void {
  CACHED_KEY = null;
}

/**
 * Write a fresh 32-byte `secret.key` to disk and adopt it as the cached
 * key for this process. Overwrites any existing file (the reset engine
 * has just wiped it) and invalidates the cache so subsequent
 * `encrypt`/`decrypt` use the new key. Returns the path written.
 *
 * Companion to the boot-only `servicebay-secret-key-init` unit — runs
 * the same regeneration in-process so a reset without an OS reboot
 * doesn't leave `secret.key` missing (which crash-loops the container on
 * its next restart). See #1246.
 */
export function regenerateSecretKey(): string {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const key = crypto.randomBytes(32); // 256 bits, raw — matches aes-256-gcm
  fs.writeFileSync(SECRET_KEY_PATH, key, { mode: 0o600 });
  CACHED_KEY = key;
  return SECRET_KEY_PATH;
}

/**
 * True iff the on-disk `config.json` carries at least one `enc:`-prefixed
 * value — i.e. there is preserved encrypted config whose plaintext can
 * only be recovered with the existing `secret.key`/`.auth-secret.env`.
 *
 * This is the regenerate-vs-preserve discriminator (#1667). Regenerating
 * the encryption keys when such config exists orphans every sealed
 * credential (the FritzBox gateway password + every OIDC/SSO client
 * secret), which is the root cause of the #1559 SSO-breakage family on a
 * wipe-config reinstall. The keys are per-box identity — same trust class
 * as the nginx certs / zwave network keys that already survive — and must
 * NOT be regenerated while there is preserved `enc:` config to protect.
 *
 * Conservative by construction:
 *   - returns `true` ONLY when a config.json exists AND contains the
 *     literal `enc:` marker (we scan the raw text, not the decrypted
 *     values, so a stale/unreadable key still counts as "has secrets to
 *     protect" — we never destroy the only thing that could decrypt them);
 *   - returns `false` for a genuinely-fresh box (no config.json, or a
 *     config with no `enc:` values) so it still generates fresh keys.
 *
 * No key material or secret value is read or logged here — only the
 * presence of the `enc:` prefix in the raw file is detected.
 */
export function hasPreservedEncryptedConfig(configPath: string = CONFIG_PATH): boolean {
  try {
    if (!fs.existsSync(configPath)) return false;
    const raw = fs.readFileSync(configPath, 'utf8');
    // `enc:` (the encryption prefix) only appears as a JSON string value
    // that secrets.ts sealed. A fresh ISO config has none.
    return raw.includes(`"${PREFIX}`);
  } catch {
    // If we can't read it, fail safe toward *preserving* nothing — an
    // unreadable config can't be the thing we're protecting, and the
    // caller's own fresh-box generation must still proceed.
    return false;
  }
}

/** Per-process flag — once a decrypt fails because the loaded
 *  `secret.key` can't validate an `enc:v1:…` value, future failures
 *  stay quiet so a config full of stale ciphertexts doesn't drown
 *  the log. The first failure still logs a single WARN. */
let DECRYPT_MISMATCH_WARNED = false;

/** True iff any decrypt() call in this process saw GCM auth-tag
 *  failure on a well-formed `enc:v1:…` string. Read by diagnose to
 *  surface the underlying problem (#780). Reset is deliberately not
 *  exported — once mismatch is detected it stays sticky. */
export function hasDecryptMismatch(): boolean {
  return DECRYPT_MISMATCH_WARNED;
}

/**
 * Encrypts a plain text string.
 * Format: enc:v1:IV:AUTH_TAG:CIPHERTEXT
 */
export function encrypt(text: string): string {
  if (!text) return text;
  // If already encrypted, skip
  if (text.startsWith(PREFIX)) return text;

  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  const ivHex = iv.toString('hex');

  return `${PREFIX}v1:${ivHex}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a cipher text string.
 * Expects format: enc:v1:IV:AUTH_TAG:CIPHERTEXT
 *
 * Returns '' on decryption failure of a well-formed `enc:v1:` value.
 * This is the key-mismatch path — under a previous design the function
 * returned the ciphertext-as-plaintext, which silently leaked `enc:v1:…`
 * strings into config fields and made downstream services adopt the
 * ciphertext as their actual admin password (#780). Empty-string lets
 * the install path treat the value as "secret unknown, regenerate" via
 * the normal saved-secrets fallback chain.
 */
export function decrypt(text: string): string {
  if (!text) return text;
  if (!text.startsWith(PREFIX)) return text; // Not encrypted

  const parts = text.split(':');
  if (parts.length !== 5) return text; // Invalid format — preserve verbatim

  try {
    // parts[0] = enc
    // parts[1] = v1
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = parts[4];

    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (e) {
    if (!DECRYPT_MISMATCH_WARNED) {
      DECRYPT_MISMATCH_WARNED = true;
      logger.warn('secrets', '[secrets] decrypt failed — secret.key likely regenerated since this value was sealed. ' +
        'Affected fields are returning empty; saved-secrets cache will be refreshed by the next install. ' +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`,);
    }
    return '';
  }
}
