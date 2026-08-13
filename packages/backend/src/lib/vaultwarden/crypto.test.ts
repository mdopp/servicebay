/**
 * Key-ladder tests (#2519).
 *
 * These pin the parts that fail *silently* when they are wrong: a wrong
 * HKDF variant, an unverified MAC, or an unsupported KDF that gets
 * papered over would all produce a "successful" push of garbage the web
 * vault cannot read — the exact failure mode
 * `assists/footgun-vaultwarden-personal-vault-write.md` warns about.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, hkdfSync, publicEncrypt, constants, randomBytes } from 'node:crypto';
import {
  decryptRsa,
  decryptSymmetric,
  decryptText,
  deriveMasterKey,
  deriveMasterPasswordHash,
  encryptSymmetric,
  hkdfExpand,
  stretchMasterKey,
  symmetricKeyFromRaw,
  VaultCryptoError,
  KDF_ARGON2ID,
  REQUIRED_KDF,
} from './crypto';

const KDF = { type: 0, iterations: 100_000 };

describe('vaultwarden key ladder', () => {
  it('matches the RFC 5869 HKDF-Expand test vector', () => {
    // RFC 5869 Test Case 1 — the *Expand* half only, which is what
    // Bitwarden uses to stretch the master key.
    const prk = Buffer.from('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    const okm = hkdfExpand(prk, info, 42);
    expect(okm.toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('is HKDF-Expand, NOT extract-then-expand — the silent-corruption trap', () => {
    // node's hkdfSync always runs Extract first. Using it here would
    // produce a plausible-looking 64-byte key that fails the user-key MAC
    // check with no hint about why, so the difference is pinned.
    const masterKey = randomBytes(32);
    const ours = hkdfExpand(masterKey, 'enc', 32);
    const extracted = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'enc', 32));
    expect(ours.equals(extracted)).toBe(false);
  });

  it('derives the master key from the lower-cased e-mail as salt', () => {
    const a = deriveMasterKey('pw', 'ServiceBay@Example.COM ', KDF);
    const b = deriveMasterKey('pw', 'servicebay@example.com', KDF);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('sends a hash, never the master password', () => {
    const masterKey = deriveMasterKey('correct horse', 'sb@example.com', KDF);
    const hash = deriveMasterPasswordHash(masterKey, 'correct horse');
    expect(hash).not.toContain('correct horse');
    expect(Buffer.from(hash, 'base64').length).toBe(32);
    // Deterministic — the server compares it to a stored value.
    expect(deriveMasterPasswordHash(masterKey, 'correct horse')).toBe(hash);
  });

  it('refuses Argon2id by name instead of computing something wrong', () => {
    expect(() => deriveMasterKey('pw', 'sb@example.com', { type: KDF_ARGON2ID, iterations: 3 }))
      .toThrow(/Argon2id/);
    expect(REQUIRED_KDF.type).toBe(0);
  });

  it('refuses an implausible iteration count', () => {
    expect(() => deriveMasterKey('pw', 'sb@example.com', { type: 0, iterations: 1 }))
      .toThrow(VaultCryptoError);
  });

  it('round-trips an EncString through the stretched key', () => {
    const stretched = stretchMasterKey(deriveMasterKey('pw', 'sb@example.com', KDF));
    const enc = encryptSymmetric('hunter2', stretched);
    expect(enc.startsWith('2.')).toBe(true);
    expect(enc).not.toContain('hunter2');
    expect(decryptText(enc, stretched)).toBe('hunter2');
  });

  it('rejects a tampered ciphertext on the MAC, not after decrypting', () => {
    const key = symmetricKeyFromRaw(randomBytes(64));
    const enc = encryptSymmetric('secret', key);
    const [head, iv, ct, mac] = [enc.slice(0, 2), ...enc.slice(2).split('|')];
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    const tampered = `${head}${iv}|${flipped.toString('base64')}|${mac}`;
    expect(() => decryptSymmetric(tampered, key)).toThrow(/MAC check/);
  });

  it('rejects a value encrypted with a different key', () => {
    const a = symmetricKeyFromRaw(randomBytes(64));
    const b = symmetricKeyFromRaw(randomBytes(64));
    expect(() => decryptText(encryptSymmetric('x', a), b)).toThrow(VaultCryptoError);
  });

  it('refuses the unauthenticated AES-CBC EncString type', () => {
    const key = symmetricKeyFromRaw(randomBytes(64));
    expect(() => decryptSymmetric('0.aXY=|Y3Q=', key)).toThrow(/unauthenticated/);
  });

  it('refuses a key that is not 64 bytes', () => {
    expect(() => symmetricKeyFromRaw(randomBytes(32))).toThrow(/64-byte/);
  });

  it('unwraps an RSA-OAEP-SHA1 organization key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const orgKeyRaw = randomBytes(64);
    const wrapped = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      orgKeyRaw,
    );
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const unwrapped = decryptRsa(`4.${wrapped.toString('base64')}`, der);
    expect(unwrapped.equals(orgKeyRaw)).toBe(true);
  });

  it('refuses an organization key in an unsupported wrapper', () => {
    expect(() => decryptRsa('9.abcd', Buffer.alloc(0))).toThrow(/unsupported encryption type 9/);
  });
});
