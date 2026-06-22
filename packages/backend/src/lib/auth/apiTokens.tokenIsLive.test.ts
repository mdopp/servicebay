import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// tokenIsLive(id) backs the token→session bridge: requireSession re-checks a
// bridged session's source token on every request, so revoking/expiring the
// token kills the session (#2047 cascading revocation extended to sessions).
// Real-fs DATA_DIR per test, mirroring apiTokens.cascade.test.ts.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-tokenlive-'));
});
afterEach(async () => {
  await (await load()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const load = () => import('@/lib/auth/apiTokens');

describe('tokenIsLive (#2047 bridge)', () => {
  it('is true for a freshly minted token', async () => {
    const { createToken, tokenIsLive } = await load();
    const { token } = await createToken({ name: 'live', scopes: ['read'], createdBy: 'admin' });
    expect(await tokenIsLive(token.id)).toBe(true);
  });

  it('is false after the token is revoked', async () => {
    const { createToken, revokeToken, tokenIsLive } = await load();
    const { token } = await createToken({ name: 'doomed', scopes: ['read'], createdBy: 'admin' });
    expect(await tokenIsLive(token.id)).toBe(true);
    await revokeToken(token.id);
    expect(await tokenIsLive(token.id)).toBe(false);
  });

  it('is false for an expired token', async () => {
    const { createToken, tokenIsLive } = await load();
    const past = new Date(Date.now() - 60_000).toISOString();
    const { token } = await createToken({ name: 'stale', scopes: ['read'], createdBy: 'admin', expiresAt: past });
    expect(await tokenIsLive(token.id)).toBe(false);
  });

  it('is false when an ancestor of a delegated token is revoked (cascade)', async () => {
    const { createToken, createDelegatedToken, revokeToken, tokenIsLive } = await load();
    const parent = await createToken({ name: 'parent', scopes: ['read', 'mutate'], createdBy: 'admin' });
    const child = await createDelegatedToken({ parentRaw: parent.secret, name: 'child', scopes: ['read'] });
    expect(await tokenIsLive(child.token.id)).toBe(true);
    await revokeToken(parent.token.id);
    expect(await tokenIsLive(child.token.id)).toBe(false); // ancestor gone → child not live
  });

  it('is false for an unknown or empty id', async () => {
    const { tokenIsLive } = await load();
    expect(await tokenIsLive('deadbeef')).toBe(false);
    expect(await tokenIsLive('')).toBe(false);
  });
});
