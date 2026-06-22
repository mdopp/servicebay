import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2048 — delegated child-mint: a token holder mints a child whose scopes are
// a (possibly implied) subset of the parent and whose TTL is no longer than
// the parent. Real-fs DATA_DIR per test, mirroring apiTokens.migration.test.ts.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-delegate-'));
});
afterEach(async () => {
  // Drain verifyToken's fire-and-forget lastUsedAt write so it can't land in the
  // next test's dataDir (DATA_DIR is a live getter) or race the rm (ENOTEMPTY).
  await (await load()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const load = () => import('@/lib/auth/apiTokens');

describe('createDelegatedToken (#2048)', () => {
  it('mints a child with a subset of parent scopes and records parentId', async () => {
    const { createToken, createDelegatedToken, listTokens } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read', 'mutate', 'lifecycle'], createdBy: 'admin',
    });

    const { token: child, secret } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read', 'mutate'],
    });

    expect(child.scopes).toEqual(['read', 'mutate']);
    expect(child.parentId).toBe(parent.id);
    expect(secret).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]+$/);

    // parentId is surfaced read-only in listTokens.
    const listed = (await listTokens()).find(t => t.id === child.id);
    expect(listed?.parentId).toBe(parent.id);
  });

  it('rejects a child requesting a scope the parent lacks (403)', async () => {
    const { createToken, createDelegatedToken, DelegateError } = await load();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read', 'mutate'], createdBy: 'admin',
    });

    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read', 'destroy'] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read', 'destroy'] }),
    ).rejects.toBeInstanceOf(DelegateError);
  });

  it('allows an implied scope: a destroy parent may mint a reboot/exec child', async () => {
    const { createToken, createDelegatedToken } = await load();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read', 'destroy'], createdBy: 'admin',
    });

    const { token: child } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['reboot', 'exec'],
    });
    expect(child.scopes).toEqual(['reboot', 'exec']);
  });

  it('rejects a child whose expiry is later than the parent (403)', async () => {
    const { createToken, createDelegatedToken } = await load();
    const parentExp = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const childExp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // +2h
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read'], expiresAt: parentExp, createdBy: 'admin',
    });

    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read'], expiresAt: childExp }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a child with no expiry when the parent expires (403)', async () => {
    const { createToken, createDelegatedToken } = await load();
    const parentExp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read'], expiresAt: parentExp, createdBy: 'admin',
    });

    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read'] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('accepts a child expiry no later than the parent', async () => {
    const { createToken, createDelegatedToken } = await load();
    const parentExp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const childExp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read'], expiresAt: parentExp, createdBy: 'admin',
    });

    const { token: child } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read'], expiresAt: childExp,
    });
    expect(child.expiresAt).toBe(childExp);
  });

  it('rejects an unknown / bad parent token (403)', async () => {
    const { createDelegatedToken } = await load();
    await expect(
      createDelegatedToken({ parentRaw: 'sb_deadbeef_BADSECRETBADSECRET', name: 'c', scopes: ['read'] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an expired parent token (403)', async () => {
    const { createToken, createDelegatedToken } = await load();
    const past = new Date(Date.now() - 1000).toISOString();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read'], expiresAt: past, createdBy: 'admin',
    });
    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read'] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a revoked parent token (403)', async () => {
    const { createToken, createDelegatedToken, revokeToken } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read'], createdBy: 'admin',
    });
    await revokeToken(parent.id);
    await expect(
      createDelegatedToken({ parentRaw, name: 'child', scopes: ['read'] }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('apiScope subset helpers (#2048)', () => {
  it('scopesAreSubset honors destroy→reboot/exec implication', async () => {
    const { scopesAreSubset } = await import('@/lib/auth/apiScope');
    expect(scopesAreSubset(['reboot', 'exec'], ['destroy'])).toBe(true);
    expect(scopesAreSubset(['read'], ['read', 'mutate'])).toBe(true);
    expect(scopesAreSubset(['destroy'], ['reboot'])).toBe(false);
    expect(scopesAreSubset(['mutate'], ['read'])).toBe(false);
  });
});
