import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2299 — non-expiring machine token: createToken accepts `neverExpires`, which
// omits `expiresAt` entirely so the token never lapses. Real-fs DATA_DIR per
// test, mirroring apiTokens.delegate.test.ts.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-neverexpires-'));
});
afterEach(async () => {
  await (await load()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const load = () => import('@/lib/auth/apiTokens');

describe('createToken neverExpires (#2299)', () => {
  it('mints a read-only + neverExpires token with NO expiresAt', async () => {
    const { createToken } = await load();
    const { token } = await createToken({
      name: 'machine', scopes: ['read'], neverExpires: true, createdBy: 'admin',
    });
    expect(token.expiresAt).toBeUndefined();
    expect(token.scopes).toEqual(['read']);
  });

  it('the never-expiring token validates and never rejects on expiry', async () => {
    const { createToken, verifyToken } = await load();
    const { secret } = await createToken({
      name: 'machine', scopes: ['read'], neverExpires: true, createdBy: 'admin',
    });
    // No amount of time makes it lapse — verifyToken never sees an expiresAt.
    const verified = await verifyToken(secret);
    expect(verified).not.toBeNull();
    expect(verified?.expiresAt).toBeUndefined();
  });

  it('neverExpires wins over an explicitly passed expiresAt (still no expiry)', async () => {
    const { createToken } = await load();
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const { token } = await createToken({
      name: 'machine', scopes: ['read'], expiresAt: soon, neverExpires: true, createdBy: 'admin',
    });
    expect(token.expiresAt).toBeUndefined();
  });

  it('neverExpires=false still respects expiresAt (no regression)', async () => {
    const { createToken } = await load();
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { token } = await createToken({
      name: 'expiring', scopes: ['read'], expiresAt: exp, neverExpires: false, createdBy: 'admin',
    });
    expect(token.expiresAt).toBe(exp);
  });

  it('neverExpires absent still respects expiresAt (no regression)', async () => {
    const { createToken } = await load();
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { token } = await createToken({
      name: 'expiring', scopes: ['read'], expiresAt: exp, createdBy: 'admin',
    });
    expect(token.expiresAt).toBe(exp);
  });

  it('an expiring token past its expiry is rejected (baseline unchanged)', async () => {
    const { createToken, verifyToken } = await load();
    const past = new Date(Date.now() - 1000).toISOString();
    const { secret } = await createToken({
      name: 'stale', scopes: ['read'], expiresAt: past, createdBy: 'admin',
    });
    expect(await verifyToken(secret)).toBeNull();
  });
});
