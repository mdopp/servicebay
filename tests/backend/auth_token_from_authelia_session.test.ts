// @vitest-environment node
// #2246 — Authelia-session → scoped SB-MCP token exchange. A verified admin's
// live forward-auth session (NPM-injected Remote-User + Remote-Groups) mints a
// short-lived read+lifecycle+mutate token; no standing minting credential sits
// in the consumer pod. Real-fs DATA_DIR so createToken/verifyToken round-trip
// through the actual store (mirrors apiTokens.delegate.test.ts).
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

// withApiHandler treats this route as public (skipAuth) — the Authelia proxy
// headers ARE the credential — so requireSession never runs. Stub it anyway so
// an accidental gate change surfaces loudly rather than mint-for-anyone.
vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => {
    throw new Error('requireSession must not run: the route is skipAuth (headers are the credential)');
  }),
}));

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ||
    '0123456789abcdef0123456789abcdef0123456789abcdef';
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-authelia-tok-'));
});
afterEach(async () => {
  const { flushPendingStamps } = await import('@/lib/auth/apiTokens');
  await flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function post(headers: Record<string, string>) {
  const { POST } = await import(
    '../../packages/frontend/src/app/api/auth/token-from-authelia-session/route'
  );
  const req = new NextRequest('http://test/api/auth/token-from-authelia-session', {
    method: 'POST',
    headers,
  });
  return POST(req);
}

describe('POST /api/auth/token-from-authelia-session (#2246)', () => {
  // Criterion (1): admin identity → a read+lifecycle+mutate Bearer expiring ≤1h.
  it('mints a read+lifecycle+mutate token expiring within 1h for an admin', async () => {
    const before = Date.now();
    const res = await post({ 'remote-user': 'admin', 'remote-groups': 'admins' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.scopes).toEqual(['read', 'lifecycle', 'mutate']);
    expect(body.token).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]+$/);

    const exp = Date.parse(body.expiresAt);
    expect(exp).toBeGreaterThan(before);
    // ≤ 1h from now (allow a small slack for test execution time).
    expect(exp).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5_000);
  });

  // Criterion (2): missing forward-auth headers → 401, no token. A direct /
  // loopback caller (no Authelia) is never trusted.
  it('rejects with 401 and mints nothing when the Remote-User header is absent', async () => {
    const res = await post({}); // no forward-auth identity
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.token).toBeUndefined();

    // Store stays empty — nothing was minted.
    const { listTokens } = await import('@/lib/auth/apiTokens');
    expect(await listTokens()).toHaveLength(0);
  });

  it('rejects with 403 when Remote-User is present but Remote-Groups is absent', async () => {
    const res = await post({ 'remote-user': 'admin' }); // identity but no groups
    expect(res.status).toBe(403);
    expect((await res.json()).token).toBeUndefined();
    const { listTokens } = await import('@/lib/auth/apiTokens');
    expect(await listTokens()).toHaveLength(0);
  });

  // Criterion (3): a non-admin group → 403, no token.
  it('rejects with 403 and mints nothing for a non-admin group', async () => {
    const res = await post({ 'remote-user': 'bob', 'remote-groups': 'family, users' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.token).toBeUndefined();

    const { listTokens } = await import('@/lib/auth/apiTokens');
    expect(await listTokens()).toHaveLength(0);
  });

  // Criterion (4): the minted token actually works on read/mutate and is
  // REFUSED on a destroy-tier tool. Verified against the SAME machinery the
  // /mcp path uses: verifyToken (store round-trip) + tokenHasScope (the gate).
  it('mints a token that passes read/mutate and is refused on destroy', async () => {
    const res = await post({ 'remote-user': 'admin', 'remote-groups': 'admins' });
    const { token: raw } = await res.json();

    const { verifyToken } = await import('@/lib/auth/apiTokens');
    const verified = await verifyToken(raw);
    expect(verified).not.toBeNull();

    const { tokenHasScope } = await import('@/lib/mcp/server');
    // read (list_*) and mutate (deploy_service) are granted.
    expect(tokenHasScope(verified!.scopes, 'read')).toBe(true);
    expect(tokenHasScope(verified!.scopes, 'lifecycle')).toBe(true);
    expect(tokenHasScope(verified!.scopes, 'mutate')).toBe(true);
    // destroy (delete_service) and exec (exec_command) are NOT — they still go
    // through the per-tool approval flow (#2234), not this token.
    expect(tokenHasScope(verified!.scopes, 'destroy')).toBe(false);
    expect(tokenHasScope(verified!.scopes, 'exec')).toBe(false);
    expect(tokenHasScope(verified!.scopes, 'reboot')).toBe(false);
  });

  // Header-spoofing note enforced: the route trusts ONLY the proxy-injected
  // header. There is no cookie/LAN-IP fallback, so a header-less caller from
  // loopback (the classic spoof vector) gets nothing. (Covered by the 401
  // test above; this pins that no session cookie can substitute.)
  it('does not accept a session cookie in lieu of the forward-auth headers', async () => {
    const { encryptSession } = await import('@/lib/auth/session');
    const cookie = await encryptSession({ user: 'admin', expires: new Date(Date.now() + 3600_000) });
    const res = await post({ cookie: `session=${cookie}` });
    expect(res.status).toBe(401);
    expect((await res.json()).token).toBeUndefined();
  });
});
