import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isPasswordHash } from '@/lib/auth/password';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(isPasswordHash(hash)).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('one');
    expect(await verifyPassword('two', hash)).toBe(false);
  });

  it('produces different hashes for the same input (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toEqual(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('rejects malformed encoded values', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$$')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$16384$abc$def')).toBe(false);
  });

  it('rejects empty password input', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('isPasswordHash distinguishes hashes from plaintext', () => {
    expect(isPasswordHash('plaintext')).toBe(false);
    expect(isPasswordHash('scrypt$16384$abc$def')).toBe(true);
    expect(isPasswordHash(123 as unknown as string)).toBe(false);
  });

  it('rejects pathological cost factor', async () => {
    expect(await verifyPassword('x', 'scrypt$0$YWJj$ZGVm')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$99999999$YWJj$ZGVm')).toBe(false);
  });
});
