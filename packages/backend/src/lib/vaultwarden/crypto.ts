/**
 * Bitwarden/Vaultwarden client-side crypto — the minimum needed to write a
 * login item into an **organization collection** (#2519).
 *
 * Why this exists at all: Vaultwarden has no server-side "store this
 * password" endpoint. Items are encrypted on the client with a symmetric
 * key the server never sees, so a pusher has to reimplement the key
 * ladder. The ladder we walk, top to bottom:
 *
 *   master password + email ──PBKDF2──▶ master key
 *   master key ──HKDF-Expand("enc"/"mac")──▶ stretched key
 *   stretched key ──AES-CBC+HMAC──▶ user key            (profile.Key)
 *   user key      ──AES-CBC+HMAC──▶ RSA private key     (profile.PrivateKey)
 *   RSA private key ──OAEP──▶ organization key          (organization.Key)
 *   organization key ──AES-CBC+HMAC──▶ the item's fields
 *
 * Only the **organization key** encrypts anything we write, which is the
 * whole point of the org-collection route: the account whose master
 * password ServiceBay holds owns nothing but what ServiceBay put there,
 * and the humans read the items through their own org membership.
 *
 * See `assists/footgun-vaultwarden-personal-vault-write.md` for why the
 * personal-vault variant of this is impossible rather than merely harder.
 *
 * No new dependency: everything here is `node:crypto`. Deliberately NOT a
 * general Bitwarden SDK — it supports exactly the EncString types the
 * account/organization key ladder uses and refuses anything else loudly.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  constants as cryptoConstants,
  pbkdf2Sync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

/** Anything the key ladder can't do. Always safe to surface to an operator:
 *  the message never contains key material. */
export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

/** A Bitwarden symmetric key: 32-byte AES key + 32-byte HMAC key. */
export interface SymmetricKey {
  enc: Buffer;
  mac: Buffer;
}

/** KDF parameters as reported by `/identity/accounts/prelogin`. */
export interface KdfParams {
  /** 0 = PBKDF2-SHA256, 1 = Argon2id. */
  type: number;
  iterations: number;
}

/** KDF type id for PBKDF2-SHA256 — the only one supported here. */
export const KDF_PBKDF2 = 0;
/** KDF type id for Argon2id. Recognised so the refusal can name it. */
export const KDF_ARGON2ID = 1;

/**
 * The KDF ServiceBay's own account must be created with.
 *
 * Argon2id (Vaultwarden's default for accounts created through the web
 * vault since 2023) has no `node:crypto` implementation, and pulling an
 * argon2 native dependency into the control plane to log into a password
 * manager is a bad trade. The technical account is created by the
 * operator following `assists/recipe-vaultwarden-servicebay-push.md`,
 * which pins PBKDF2 — and the strength that matters here comes from the
 * password being machine-generated and long, not from the KDF hardening
 * a human-memorable one.
 */
export const REQUIRED_KDF: KdfParams = { type: KDF_PBKDF2, iterations: 600_000 };

/** Split a 64-byte Bitwarden key into its AES and HMAC halves. */
export function symmetricKeyFromRaw(raw: Buffer): SymmetricKey {
  if (raw.length !== 64) {
    throw new VaultCryptoError(
      `expected a 64-byte encryption key, got ${raw.length} bytes — the vault returned a key shape this client does not support`,
    );
  }
  return { enc: raw.subarray(0, 32), mac: raw.subarray(32, 64) };
}

/**
 * HKDF-Expand (RFC 5869 §2.3) over SHA-256.
 *
 * Bitwarden stretches the master key with Expand **only** — no Extract
 * step — so `crypto.hkdfSync` (which always extracts) produces the wrong
 * bytes and silently yields a key that fails the MAC check later.
 */
export function hkdfExpand(prk: Buffer, info: string | Buffer, length: number): Buffer {
  const infoBytes = typeof info === 'string' ? Buffer.from(info, 'utf8') : info;
  const out: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    const h = createHmac('sha256', prk);
    h.update(previous);
    h.update(infoBytes);
    h.update(Buffer.from([i]));
    previous = h.digest();
    out.push(previous);
  }
  return Buffer.concat(out).subarray(0, length);
}

/** PBKDF2(master password, e-mail) — the root of the ladder. */
export function deriveMasterKey(password: string, email: string, kdf: KdfParams): Buffer {
  if (kdf.type !== KDF_PBKDF2) {
    throw new VaultCryptoError(
      kdf.type === KDF_ARGON2ID
        ? 'this Vaultwarden account uses the Argon2id KDF, which ServiceBay cannot compute. Re-create the ServiceBay account with the PBKDF2 KDF (see assists/recipe-vaultwarden-servicebay-push.md).'
        : `unsupported KDF type ${kdf.type} on the ServiceBay Vaultwarden account`,
    );
  }
  if (!Number.isFinite(kdf.iterations) || kdf.iterations < 5000) {
    throw new VaultCryptoError(`implausible PBKDF2 iteration count (${kdf.iterations}) reported by the vault`);
  }
  const salt = email.trim().toLowerCase();
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), kdf.iterations, 32, 'sha256');
}

/**
 * The value sent as `password` in the token request. It is a *hash*, not
 * the master password — the server only ever sees this.
 */
export function deriveMasterPasswordHash(masterKey: Buffer, password: string): string {
  return pbkdf2Sync(masterKey, Buffer.from(password, 'utf8'), 1, 32, 'sha256').toString('base64');
}

/** Stretch the 32-byte master key into the 64-byte key that wraps the user key. */
export function stretchMasterKey(masterKey: Buffer): SymmetricKey {
  return {
    enc: hkdfExpand(masterKey, 'enc', 32),
    mac: hkdfExpand(masterKey, 'mac', 32),
  };
}

/** EncString type ids (`<type>.<payload>`). */
export const ENC_AES_CBC256_HMAC_SHA256 = 2;
const ENC_AES_CBC256 = 0;
const ENC_RSA_OAEP_SHA256 = 3;
const ENC_RSA_OAEP_SHA1 = 4;
const ENC_RSA_OAEP_SHA256_HMAC = 5;
const ENC_RSA_OAEP_SHA1_HMAC = 6;

interface ParsedEncString {
  type: number;
  parts: string[];
}

function parseEncString(value: string): ParsedEncString {
  const raw = (value ?? '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) throw new VaultCryptoError('malformed encrypted value (no type prefix)');
  const type = Number.parseInt(raw.slice(0, dot), 10);
  if (!Number.isFinite(type)) throw new VaultCryptoError('malformed encrypted value (bad type prefix)');
  return { type, parts: raw.slice(dot + 1).split('|') };
}

/**
 * Decrypt an AES-CBC-256 + HMAC-SHA256 EncString.
 *
 * The MAC is verified **before** decrypting and compared in constant
 * time; a value that fails it is treated as undecryptable rather than
 * decrypted-then-checked.
 */
export function decryptSymmetric(value: string, key: SymmetricKey): Buffer {
  const { type, parts } = parseEncString(value);
  if (type === ENC_AES_CBC256) {
    throw new VaultCryptoError('encrypted value uses the unauthenticated AES-CBC type, which this client refuses');
  }
  if (type !== ENC_AES_CBC256_HMAC_SHA256) {
    throw new VaultCryptoError(`encrypted value uses unsupported type ${type}`);
  }
  const [ivB64, ctB64, macB64] = parts;
  if (!ivB64 || !ctB64 || !macB64) throw new VaultCryptoError('encrypted value is missing iv/ciphertext/mac');
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const mac = Buffer.from(macB64, 'base64');

  const expected = createHmac('sha256', key.mac).update(iv).update(ct).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new VaultCryptoError('encrypted value failed its MAC check (wrong key or tampered value)');
  }

  const decipher = createDecipheriv('aes-256-cbc', key.enc, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Decrypt to UTF-8 text. */
export function decryptText(value: string, key: SymmetricKey): string {
  return decryptSymmetric(value, key).toString('utf8');
}

/** Encrypt to an AES-CBC-256 + HMAC-SHA256 EncString (`2.iv|ct|mac`). */
export function encryptSymmetric(plaintext: string | Buffer, key: SymmetricKey): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key.enc, iv);
  const ct = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  const mac = createHmac('sha256', key.mac).update(iv).update(ct).digest();
  return `${ENC_AES_CBC256_HMAC_SHA256}.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

/**
 * Decrypt an RSA-wrapped EncString — the shape an organization key
 * arrives in (wrapped to the member's public key).
 *
 * `privateKeyDer` is the PKCS#8 DER that came out of `profile.PrivateKey`.
 */
export function decryptRsa(value: string, privateKeyDer: Buffer): Buffer {
  const { type, parts } = parseEncString(value);
  const oaepHash =
    type === ENC_RSA_OAEP_SHA1 || type === ENC_RSA_OAEP_SHA1_HMAC
      ? 'sha1'
      : type === ENC_RSA_OAEP_SHA256 || type === ENC_RSA_OAEP_SHA256_HMAC
        ? 'sha256'
        : null;
  if (!oaepHash) {
    throw new VaultCryptoError(`organization key uses unsupported encryption type ${type}`);
  }
  // Types 5/6 append an HMAC of the ciphertext; the payload is part 0
  // either way, and OAEP already authenticates the decryption.
  const data = Buffer.from(parts[0] ?? '', 'base64');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  } catch (e) {
    throw new VaultCryptoError(`account private key could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return privateDecrypt({ key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash }, data);
}
