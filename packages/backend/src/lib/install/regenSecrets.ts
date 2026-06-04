/**
 * In-process regeneration of ServiceBay's two boot-critical key files
 * after a stack reset wipes them. See #1246.
 *
 * The reset engine (`performStackReset`) removes `secret.key` and
 * `.auth-secret.env` from the data dir, but the units that regenerate
 * them (`servicebay-secret-key-init`, `servicebay-auth-secret-init`)
 * only run on boot. A reset without an OS reboot therefore leaves both
 * files missing: the running container survives on its in-memory copies
 * until its next restart (a config-save firing `servicebay-trigger.path`
 * or an image auto-update), at which point `assertAuthSecret()` throws
 * (no `.auth-secret.env`) and the container crash-loops forever with no
 * self-recovery.
 *
 * These helpers do the same regeneration the boot units do, in-process,
 * so the files exist again immediately. No reboot is needed — the
 * freshly-restarted container picks them up. Formats match the boot
 * units byte-for-byte:
 *   - secret.key       → 32 raw random bytes, mode 0600 (handled by
 *                        `regenerateSecretKey()` in secrets.ts, which
 *                        also invalidates the in-memory key cache)
 *   - .auth-secret.env → `AUTH_SECRET=<64 hex chars>\n`, mode 0600
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { regenerateSecretKey, hasPreservedEncryptedConfig } from '@/lib/secrets';
import { logger } from '@/lib/logger';

const AUTH_SECRET_ENV_PATH = path.join(DATA_DIR, '.auth-secret.env');
const SECRET_KEY_PATH = path.join(DATA_DIR, 'secret.key');

/**
 * Write a fresh `.auth-secret.env` to disk. Overwrites any existing file
 * (the reset has just wiped it). The new `AUTH_SECRET` is a 32-byte
 * hex string (64 chars), comfortably over `assertAuthSecret()`'s 32-char
 * floor. Returns the path written.
 */
export function regenerateAuthSecretEnv(): string {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  fs.writeFileSync(AUTH_SECRET_ENV_PATH, `AUTH_SECRET=${secret}\n`, { mode: 0o600 });
  return AUTH_SECRET_ENV_PATH;
}

export interface RegenResult {
  secretKeyPath: string;
  authSecretEnvPath: string;
}

/**
 * Regenerate both boot-critical key files in-process after a wipe.
 * Invalidates the in-memory `secret.key` cache so the next `encrypt()`
 * uses the freshly-written key (the same one a rebooted container would
 * load). Throws on IO failure — the caller must not silently swallow
 * this, or the crash-loop it prevents simply returns (see
 * `feedback_dont_mask_failures`).
 */
export function regenerateWipedKeys(): RegenResult {
  const secretKeyPath = regenerateSecretKey();
  const authSecretEnvPath = regenerateAuthSecretEnv();
  logger.info('StackReset', 'Regenerated secret.key + .auth-secret.env in-process after wipe (#1246).');
  return { secretKeyPath, authSecretEnvPath };
}

export interface PreserveOrRegenResult extends RegenResult {
  /** `true` when preserved `enc:` config was detected and the existing
   *  keys were KEPT (not regenerated); `false` when fresh keys were
   *  generated (a genuinely-fresh box, or no encrypted config to protect). */
  preserved: boolean;
}

/**
 * Regenerate-vs-preserve gate for the two boot-critical key files (#1667).
 *
 * Mirrors the FCoS boot init units' "preserve if present" semantics, but
 * with an explicit decrypt-protection guard: when the on-disk `config.json`
 * carries `enc:` values, the existing `secret.key`/`.auth-secret.env` are
 * the ONLY thing that can decrypt them (the FritzBox gateway password +
 * every OIDC/SSO client secret). Regenerating fresh keys in that state
 * orphans all of those credentials — the root cause of the #1559 SSO-
 * breakage family on a wipe-config reinstall.
 *
 * Decision is unambiguous and conservative:
 *   - preserved `enc:` config present AND both key files already exist
 *     → KEEP the keys verbatim, regenerate nothing (`preserved: true`);
 *   - otherwise (fresh box, no `enc:` config, or a key file missing while
 *     no protected config exists) → generate fresh keys exactly as
 *     `regenerateWipedKeys` does (`preserved: false`).
 *
 * Note: if encrypted config exists but a key file is somehow missing, we do
 * NOT silently mint a new key over the preserved ciphertext (that would
 * orphan it) — we leave the present file(s) untouched and surface that the
 * encrypted config can no longer be recovered, rather than masking it.
 * No key material is logged.
 */
export function regenerateWipedKeysUnlessPreservedConfig(): PreserveOrRegenResult {
  if (hasPreservedEncryptedConfig()) {
    const haveSecretKey = fs.existsSync(SECRET_KEY_PATH);
    const haveAuthSecret = fs.existsSync(AUTH_SECRET_ENV_PATH);
    if (haveSecretKey && haveAuthSecret) {
      logger.info(
        'StackReset',
        'Preserved secret.key + .auth-secret.env — config.json carries enc: values that only the existing keys can decrypt (#1667).',
      );
      return { secretKeyPath: SECRET_KEY_PATH, authSecretEnvPath: AUTH_SECRET_ENV_PATH, preserved: true };
    }
    // Encrypted config exists but a key file is missing: minting a fresh
    // key here would orphan the preserved ciphertext. Don't mask it —
    // keep whatever survives and let decrypt() surface the mismatch.
    logger.warn(
      'StackReset',
      'config.json carries enc: values but a key file is missing — NOT minting a fresh key over preserved ciphertext (#1667). ' +
        'Encrypted credentials may be unrecoverable; restore the original secret.key/.auth-secret.env.',
    );
    return { secretKeyPath: SECRET_KEY_PATH, authSecretEnvPath: AUTH_SECRET_ENV_PATH, preserved: true };
  }
  const { secretKeyPath, authSecretEnvPath } = regenerateWipedKeys();
  return { secretKeyPath, authSecretEnvPath, preserved: false };
}
