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

  it('allows an implied scope: a destroy parent may mint a reboot child', async () => {
    const { createToken, createDelegatedToken } = await load();
    const { secret: parentRaw } = await createToken({
      name: 'parent', scopes: ['read', 'destroy'], createdBy: 'admin',
    });

    const { token: child } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['reboot'],
    });
    expect(child.scopes).toEqual(['reboot']);
  });

  // #2623: `destroy` no longer implies `exec`, so a destroy parent can no
  // longer delegate shell it never held. Only a parent literally holding
  // `exec` may mint an `exec` child.
  it('refuses an exec child from a destroy-only parent, allows it from an exec parent', async () => {
    const { createToken, createDelegatedToken } = await load();
    const { secret: destroyParent } = await createToken({
      name: 'destroy-parent', scopes: ['read', 'destroy'], createdBy: 'admin',
    });
    await expect(
      createDelegatedToken({ parentRaw: destroyParent, name: 'child', scopes: ['exec'] }),
    ).rejects.toMatchObject({ status: 403 });

    const { secret: execParent } = await createToken({
      name: 'exec-parent', scopes: ['read', 'exec'], createdBy: 'admin',
    });
    const { token: child } = await createDelegatedToken({
      parentRaw: execParent, name: 'child', scopes: ['exec'],
    });
    expect(child.scopes).toEqual(['exec']);
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

describe('revokeDelegatedToken (#2680)', () => {
  /** Parent + two children delegated from it — the shape every claim below
   *  needs, because a single-child store cannot show a sibling surviving. */
  async function family() {
    const { createToken, createDelegatedToken } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'claude-dev', scopes: ['read'], createdBy: 'admin',
    });
    const a = await createDelegatedToken({ parentRaw, name: 'project a', scopes: ['read'] });
    const b = await createDelegatedToken({ parentRaw, name: 'project b', scopes: ['read'] });
    return { parentRaw, parent, a, b };
  }

  it('revokes EXACTLY the named child and leaves its siblings usable', async () => {
    const { revokeDelegatedToken, listTokens, verifyToken } = await load();
    const { parentRaw, parent, a, b } = await family();
    expect(await listTokens()).toHaveLength(3);

    const revoked = await revokeDelegatedToken({ parentRaw, childId: a.token.id });
    expect(revoked.id).toBe(a.token.id);

    // Counted, not asserted: exactly one row left the store.
    const left = await listTokens();
    expect(left.map(t => t.id).sort()).toEqual([parent.id, b.token.id].sort());
    // The sibling is not merely listed — it still authenticates.
    expect((await verifyToken(b.secret))?.id).toBe(b.token.id);
    expect(await verifyToken(a.secret)).toBeNull();
  });

  it('refuses a token that is not this parent\'s child, and revokes nothing (403)', async () => {
    const { createToken, createDelegatedToken, revokeDelegatedToken, listTokens } = await load();
    const { parentRaw, a } = await family();
    // A second family: same shape, different parent.
    const { secret: otherRaw } = await createToken({ name: 'other', scopes: ['read'], createdBy: 'admin' });
    const stranger = await createDelegatedToken({ parentRaw: otherRaw, name: 'not yours', scopes: ['read'] });

    await expect(revokeDelegatedToken({ parentRaw, childId: stranger.token.id }))
      .rejects.toMatchObject({ status: 403 });
    // The refusal is total: nothing at all was removed.
    expect(await listTokens()).toHaveLength(5);
    expect(await revokeDelegatedToken({ parentRaw, childId: a.token.id })).toMatchObject({ id: a.token.id });
  });

  it('refuses the parent itself — a token cannot revoke its own credential here (403)', async () => {
    const { revokeDelegatedToken, listTokens } = await load();
    const { parentRaw, parent } = await family();
    await expect(revokeDelegatedToken({ parentRaw, childId: parent.id }))
      .rejects.toMatchObject({ status: 403 });
    expect(await listTokens()).toHaveLength(3);
  });

  it('an id that is not in the store is 404, never a silent success', async () => {
    const { revokeDelegatedToken, listTokens } = await load();
    const { parentRaw } = await family();
    await expect(revokeDelegatedToken({ parentRaw, childId: 'deadbeef' }))
      .rejects.toMatchObject({ status: 404 });
    // Nothing was removed on the way to that refusal.
    expect(await listTokens()).toHaveLength(3);
  });

  it('rejects a malformed id (400) and a bad parent credential (403)', async () => {
    const { revokeDelegatedToken } = await load();
    const { parentRaw, a } = await family();
    await expect(revokeDelegatedToken({ parentRaw, childId: 'not-an-id' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(revokeDelegatedToken({ parentRaw: 'sb_00000000_NOPE', childId: a.token.id }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('a second revoke of the same child is 404 — remove is not silently idempotent', async () => {
    const { revokeDelegatedToken } = await load();
    const { parentRaw, a } = await family();
    await revokeDelegatedToken({ parentRaw, childId: a.token.id });
    await expect(revokeDelegatedToken({ parentRaw, childId: a.token.id }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('apiScope subset helpers (#2048)', () => {
  it('scopesAreSubset honors destroy→reboot, but never destroy→exec (#2623)', async () => {
    const { scopesAreSubset } = await import('@/lib/auth/apiScope');
    expect(scopesAreSubset(['reboot'], ['destroy'])).toBe(true);
    expect(scopesAreSubset(['exec'], ['destroy'])).toBe(false);
    expect(scopesAreSubset(['reboot', 'exec'], ['destroy'])).toBe(false);
    expect(scopesAreSubset(['exec'], ['exec'])).toBe(true);
    expect(scopesAreSubset(['read'], ['read', 'mutate'])).toBe(true);
    expect(scopesAreSubset(['destroy'], ['reboot'])).toBe(false);
    expect(scopesAreSubset(['mutate'], ['read'])).toBe(false);
  });
});
