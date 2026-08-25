import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2139 — expired-token sweeper: an expired token is not just rejected by
// verifyToken, it is DELETED from api-tokens.json (no dead rows). #2606 put a
// three-day grace in front of that deletion so a just-lapsed token stays
// listed (and visibly expired) long enough to explain a client's sudden 401.
// Real-fs DATA_DIR per test, mirroring apiTokens.delegate.test.ts.
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

const DAY = 24 * 60 * 60 * 1000;
/** Lapsed a minute ago — expired, but still inside the grace window. */
const justExpired = () => new Date(Date.now() - 60_000).toISOString();
/** Lapsed four days ago — past the three-day grace, so sweepable. */
const longExpired = () => new Date(Date.now() - 4 * DAY).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe('sweepExpiredTokens (#2139, grace #2606)', () => {
  it('deletes rows past the grace period and keeps live ones, returning swept ids', async () => {
    const { createToken, sweepExpiredTokens, listTokens } = await load();
    const { token: dead } = await createToken({ name: 'dead', scopes: ['read'], expiresAt: longExpired(), createdBy: 'admin' });
    const { token: alive } = await createToken({ name: 'alive', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    const { token: eternal } = await createToken({ name: 'eternal', scopes: ['read'], createdBy: 'admin' });

    const swept = await sweepExpiredTokens();
    expect(swept).toEqual([dead.id]);

    const remaining = (await listTokens()).map(t => t.id).sort();
    expect(remaining).toEqual([alive.id, eternal.id].sort());
  });

  // #2606, the whole point of the grace: a token that lapsed an hour ago must
  // still be *visible* as expired. Deleting it on the dot left the operator
  // with a client failing on "Invalid token" and nothing in the UI to explain
  // why — the credential was simply gone.
  it('keeps a just-expired token listed until its grace runs out, and never authenticates it', async () => {
    const { createToken, sweepExpiredTokens, listTokens, verifyToken, EXPIRY_GRACE_MS } = await load();
    const { token: lapsed, secret } = await createToken({ name: 'lapsed', scopes: ['read'], expiresAt: justExpired(), createdBy: 'admin' });

    expect(await sweepExpiredTokens()).toEqual([]);
    const listed = await listTokens();
    expect(listed.map(t => t.id)).toContain(lapsed.id);
    // Visible, but dead: expired tokens are refused before the hash check.
    expect(await verifyToken(secret)).toBeNull();

    // Once the grace has passed, the same row is swept.
    const swept = await sweepExpiredTokens(Date.now() + EXPIRY_GRACE_MS + 1000);
    expect(swept).toEqual([lapsed.id]);
    expect((await listTokens()).map(t => t.id)).not.toContain(lapsed.id);
  });

  it('is a no-op (no swept ids) when nothing is past its grace', async () => {
    const { createToken, sweepExpiredTokens } = await load();
    await createToken({ name: 'a', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    await createToken({ name: 'b', scopes: ['read'], createdBy: 'admin' });
    expect(await sweepExpiredTokens()).toEqual([]);
  });

  it('verifyToken rejects an expired token AND the verify path sweeps out past-grace rows', async () => {
    const { createToken, verifyToken, flushPendingStamps, listTokens } = await load();
    // A live token whose verify triggers the opportunistic sweep.
    const { secret: liveRaw } = await createToken({ name: 'live', scopes: ['read'], expiresAt: future(), createdBy: 'admin' });
    const { secret: deadRaw, token: dead } = await createToken({ name: 'dead', scopes: ['read'], expiresAt: longExpired(), createdBy: 'admin' });
    const { token: lapsed } = await createToken({ name: 'lapsed', scopes: ['read'], expiresAt: justExpired(), createdBy: 'admin' });

    // Expired token is rejected.
    expect(await verifyToken(deadRaw)).toBeNull();

    // Verifying the live token stamps lastUsedAt AND sweeps the past-grace row.
    expect(await verifyToken(liveRaw)).not.toBeNull();
    await flushPendingStamps();

    const remaining = (await listTokens()).map(t => t.id);
    expect(remaining).not.toContain(dead.id);
    // …but leaves the one still inside its grace window alone.
    expect(remaining).toContain(lapsed.id);
  });
});

// #2606 — the reference box holds 34 tokens of which 0 are expired, 22 never
// expire and 8 were never used. No sweep can ever touch those, so the answer
// is to count them and show them, not to guess and delete.
describe('summarizeTokenHygiene (#2606)', () => {
  it('counts never-expiring, never-used, dormant, privileged and in-grace rows', async () => {
    const { summarizeTokenHygiene } = await load();
    const now = Date.now();
    const summary = summarizeTokenHygiene([
      { scopes: ['read'] },                                                            // dormant: no expiry, never used
      { scopes: ['read'], lastUsedAt: new Date(now - DAY).toISOString() },              // never expires, used
      { scopes: ['read', 'destroy'] },                                                  // dormant + privileged
      { scopes: ['read'], expiresAt: new Date(now + DAY).toISOString(), lastUsedAt: new Date(now).toISOString() },
      { scopes: ['exec'], expiresAt: new Date(now - 60_000).toISOString(), lastUsedAt: new Date(now).toISOString() }, // expired, in grace
    ], now);

    expect(summary).toEqual({
      total: 5,
      expiredInGrace: 1,
      neverExpires: 3,
      neverUsed: 2,
      dormant: 2,
      privileged: 2,
    });
  });

  // #2606 asks explicitly whether `lastUsedAt` is written reliably — the whole
  // never-used/dormant distinction rests on it, and a stamp that silently
  // failed would report healthy tokens as dead ones.
  it('a verified token is persisted as used, so it stops counting as never-used', async () => {
    const { createToken, verifyToken, flushPendingStamps, listTokens, summarizeTokenHygiene } = await load();
    const { secret } = await createToken({ name: 'agent', scopes: ['read'], createdBy: 'admin' });
    expect(summarizeTokenHygiene(await listTokens()).neverUsed).toBe(1);

    expect(await verifyToken(secret)).not.toBeNull();
    await flushPendingStamps();

    const [row] = await listTokens();
    expect(row.lastUsedAt).toBeTruthy();
    expect(summarizeTokenHygiene(await listTokens())).toMatchObject({ neverUsed: 0, dormant: 0, neverExpires: 1 });
  });

  it('reports zeroes for an empty store rather than throwing', async () => {
    const { summarizeTokenHygiene } = await load();
    expect(summarizeTokenHygiene([])).toEqual({
      total: 0, expiredInGrace: 0, neverExpires: 0, neverUsed: 0, dormant: 0, privileged: 0,
    });
  });
});

// #2608 — bulk revoke must report a denominator. Every requested id gets its
// own outcome; an id that revoked nothing is never counted as a success.
describe('revokeTokens (#2608)', () => {
  it('revokes many in one write and reports each id, including the ones that did nothing', async () => {
    const { createToken, revokeTokens, listTokens } = await load();
    const { token: a } = await createToken({ name: 'a', scopes: ['read'], createdBy: 'admin' });
    const { token: b } = await createToken({ name: 'b', scopes: ['destroy'], createdBy: 'admin' });
    const { token: keep } = await createToken({ name: 'keep', scopes: ['read'], createdBy: 'admin' });

    const results = await revokeTokens([a.id, 'deadbeef', b.id]);
    expect(results.map(r => ({ id: r.id, ok: r.ok }))).toEqual([
      { id: a.id, ok: true },
      { id: 'deadbeef', ok: false },
      { id: b.id, ok: true },
    ]);
    // The failure says why, and names are captured before deletion.
    expect(results[1].error).toMatch(/not found/i);
    expect(results.map(r => r.name)).toEqual(['a', undefined, 'b']);

    expect((await listTokens()).map(t => t.id)).toEqual([keep.id]);
  });

  it('collapses duplicate ids to one result and no-ops on an empty list', async () => {
    const { createToken, revokeTokens, listTokens } = await load();
    const { token: a } = await createToken({ name: 'a', scopes: ['read'], createdBy: 'admin' });
    expect(await revokeTokens([])).toEqual([]);
    const results = await revokeTokens([a.id, a.id]);
    expect(results).toHaveLength(1);
    expect(await listTokens()).toEqual([]);
  });
});
