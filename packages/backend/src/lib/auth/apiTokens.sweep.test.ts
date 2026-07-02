import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2139 — expired-token sweeper: an expired token is not just rejected by
// verifyToken, it is DELETED from api-tokens.json (no dead rows). Real-fs
// DATA_DIR per test, mirroring apiTokens.delegate.test.ts.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-sweep-'));
});
afterEach(async () => {
  await (await load()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const load = () => import('@/lib/auth/apiTokens');

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe('sweepExpiredTokens (#2139)', () => {
  it('deletes expired rows and keeps live ones, returning swept ids', async () => {
    const { createToken, sweepExpiredTokens, listTokens } = await load();
    const { token: dead } = await createToken({ name: 'dead', scopes: ['read'], expiresAt: past(), createdBy: 'admin' });
    const { token: alive } = await createToken({ name: 'alive', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    const { token: eternal } = await createToken({ name: 'eternal', scopes: ['read'], createdBy: 'admin' });

    const swept = await sweepExpiredTokens();
    expect(swept).toEqual([dead.id]);

    const remaining = (await listTokens()).map(t => t.id).sort();
    expect(remaining).toEqual([alive.id, eternal.id].sort());
  });

  it('is a no-op (no swept ids) when nothing is expired', async () => {
    const { createToken, sweepExpiredTokens } = await load();
    await createToken({ name: 'a', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    await createToken({ name: 'b', scopes: ['read'], createdBy: 'admin' });
    expect(await sweepExpiredTokens()).toEqual([]);
  });

  it('verifyToken rejects an expired token AND the verify path sweeps it out', async () => {
    const { createToken, verifyToken, flushPendingStamps, listTokens } = await load();
    // A live token whose verify triggers the opportunistic sweep.
    const { secret: liveRaw } = await createToken({ name: 'live', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    const { secret: deadRaw, token: dead } = await createToken({ name: 'dead', scopes: ['read'], expiresAt: past(), createdBy: 'admin' });

    // Expired token is rejected.
    expect(await verifyToken(deadRaw)).toBeNull();

    // Verifying the live token stamps lastUsedAt AND sweeps the dead row.
    expect(await verifyToken(liveRaw)).not.toBeNull();
    await flushPendingStamps();

    const remaining = (await listTokens()).map(t => t.id);
    expect(remaining).not.toContain(dead.id);
  });
});
