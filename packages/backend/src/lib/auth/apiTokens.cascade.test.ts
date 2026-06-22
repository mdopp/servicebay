import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2049 — lazy cascading revocation: verifyToken walks UP the parentId chain
// and rejects a token whose any ancestor is revoked, expired, or missing.
// Real-fs DATA_DIR per test, mirroring apiTokens.delegate.test.ts.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-cascade-'));
});
afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const load = () => import('@/lib/auth/apiTokens');

const TOKENS_FILE = () => path.join(dataDir, 'api-tokens.json');
async function readStore() {
  return JSON.parse(await fsp.readFile(TOKENS_FILE(), 'utf-8')) as {
    tokens: Array<Record<string, unknown>>;
  };
}
async function writeStore(data: unknown) {
  await fsp.writeFile(TOKENS_FILE(), JSON.stringify(data, null, 2));
}

describe('verifyToken cascading revocation (#2049)', () => {
  it('a root token (no parentId) verifies and is unaffected by the walk', async () => {
    const { createToken, verifyToken } = await load();
    const { secret } = await createToken({ name: 'root', scopes: ['read'], createdBy: 'admin' });
    const v = await verifyToken(secret);
    expect(v).not.toBeNull();
    expect(v?.parentId).toBeUndefined();
  });

  it('a child verifies while its parent is live', async () => {
    const { createToken, createDelegatedToken, verifyToken } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read', 'mutate'], createdBy: 'admin',
    });
    const { secret: childRaw } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read'],
    });
    const v = await verifyToken(childRaw);
    expect(v).not.toBeNull();
    expect(v?.parentId).toBe(parent.id);
  });

  it('revoking the parent makes the child fail verification', async () => {
    const { createToken, createDelegatedToken, verifyToken, revokeToken } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read'], createdBy: 'admin',
    });
    const { secret: childRaw } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read'],
    });
    // Child valid before revoke.
    expect(await verifyToken(childRaw)).not.toBeNull();

    await revokeToken(parent.id);
    expect(await verifyToken(childRaw)).toBeNull();
  });

  it('revoking the grandparent makes the grandchild fail (multi-hop walk)', async () => {
    const { createToken, createDelegatedToken, verifyToken, revokeToken } = await load();
    const { secret: gpRaw, token: gp } = await createToken({
      name: 'grandparent', scopes: ['read'], createdBy: 'admin',
    });
    const { secret: pRaw } = await createDelegatedToken({
      parentRaw: gpRaw, name: 'parent', scopes: ['read'],
    });
    const { secret: gcRaw } = await createDelegatedToken({
      parentRaw: pRaw, name: 'grandchild', scopes: ['read'],
    });
    expect(await verifyToken(gcRaw)).not.toBeNull();

    await revokeToken(gp.id);
    expect(await verifyToken(gcRaw)).toBeNull();
    // The (now orphaned) middle parent also fails — its grandparent is gone.
    expect(await verifyToken(pRaw)).toBeNull();
  });

  it('an expired ancestor makes the descendant fail', async () => {
    const { createToken, createDelegatedToken, verifyToken } = await load();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read'], expiresAt: future, createdBy: 'admin',
    });
    const { secret: childRaw, token: child } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read'], expiresAt: future,
    });
    expect(await verifyToken(childRaw)).not.toBeNull();

    // Rewrite the parent's expiry into the past directly in the store; the
    // child itself is still unexpired, so only the cascade can reject it.
    const store = await readStore();
    const p = store.tokens.find(t => t.id === parent.id)!;
    p.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeStore(store);

    expect(child.expiresAt).toBe(future); // sanity: child not expired itself
    expect(await verifyToken(childRaw)).toBeNull();
  });

  it('a missing parent (store inconsistency) makes the child fail', async () => {
    const { createToken, createDelegatedToken, verifyToken } = await load();
    const { secret: parentRaw, token: parent } = await createToken({
      name: 'parent', scopes: ['read'], createdBy: 'admin',
    });
    const { secret: childRaw } = await createDelegatedToken({
      parentRaw, name: 'child', scopes: ['read'],
    });

    // Drop the parent record directly (not via revokeToken) to simulate a
    // store inconsistency; the child still points at a now-absent parentId.
    const store = await readStore();
    store.tokens = store.tokens.filter(t => t.id !== parent.id);
    await writeStore(store);

    expect(await verifyToken(childRaw)).toBeNull();
  });

  it('a self-referential parentId (cycle) is treated as invalid', async () => {
    const { createToken, verifyToken } = await load();
    const { secret } = await createToken({ name: 'loop', scopes: ['read'], createdBy: 'admin' });

    const store = await readStore();
    // Point the token's parentId at itself — a 1-node cycle.
    store.tokens[0].parentId = store.tokens[0].id;
    await writeStore(store);

    expect(await verifyToken(secret)).toBeNull();
  });

  it('an over-deep / cyclic chain (A→B→A) is treated as invalid', async () => {
    const { createToken, verifyToken } = await load();
    // Mint two tokens, then wire them into a mutual cycle in the store.
    const { secret: aRaw } = await createToken({ name: 'a', scopes: ['read'], createdBy: 'admin' });
    await createToken({ name: 'b', scopes: ['read'], createdBy: 'admin' });

    const store = await readStore();
    const a = store.tokens[0];
    const b = store.tokens[1];
    a.parentId = b.id;
    b.parentId = a.id;
    await writeStore(store);

    expect(await verifyToken(aRaw)).toBeNull();
  });
});
