/**
 * `GET /api/services` accepts a read-scoped Bearer token (#2899).
 *
 * REST routes opt into named-token auth per handler (`withApiHandler({
 * tokenScope })`, #1264). `/api/services` never opted in, so `requireSession`
 * skipped its Bearer branch entirely and a *valid* `read` token fell through to
 * the (absent) cookie and 401'd — while the same token worked on `/api/settings`.
 *
 * These tests run the REAL `requireSession` against the REAL token store on a
 * throwaway DATA_DIR, because the bug lived exactly in the seam between the two:
 * a mocked gate would have passed both before and after the fix. Both directions
 * are pinned:
 *
 *   - a live `read` token gets the list (the fix), and
 *   - a bad / expired / wrong-scope Bearer still 401s — the "presented-but-
 *     rejected must not fall through to the cookie check" rule in
 *     `requireSession` is what makes opting in safe, so it gets its own cases.
 *
 * POST is asserted unchanged: it carries no `tokenScope`, so it stays
 * cookie/internal-only and refuses every Bearer, `read` or `mutate` alike.
 *
 * No token value is ever hard-coded — every secret here is minted at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real token store, real verifyToken — on a temp DATA_DIR. Set before any
// import so `apiTokens`'s module-level TOKENS_FILE resolves under it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-services-scope-'));
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({ externalLinks: [], gateway: { host: '192.0.2.1' } })),
  saveConfig: vi.fn(async () => {}),
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: () => [], getLastResult: () => null, saveCheck: vi.fn() },
}));

vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));
vi.mock('@/lib/store/repository', () => ({ getNodeTwin: vi.fn(() => null) }));

const listServices = vi.fn(async () => ([
  { name: 'immich', active: true, status: 'running', ports: [], volumes: [], labels: {} },
]));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    listServices: (...a: unknown[]) => listServices(...(a as [])),
    deployKubeService: vi.fn(async () => {}),
  },
}));

import { GET, POST } from '@/app/api/services/route';

type Minted = { secret: string };
const minted: Record<string, Minted> = {};

const call = (
  handler: typeof GET,
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
) => handler(new NextRequest('http://test/api/services', { method, headers }));

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

beforeAll(async () => {
  const { createToken } = await import('@/lib/auth/apiTokens');
  minted.read = { secret: (await createToken({
    name: 'test-read', scopes: ['read'], createdBy: 'test',
  })).secret };
  minted.mutate = { secret: (await createToken({
    name: 'test-mutate', scopes: ['mutate'], createdBy: 'test',
  })).secret };
  minted.expired = { secret: (await createToken({
    name: 'test-expired',
    scopes: ['read'],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    createdBy: 'test',
  })).secret };
});

afterAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

beforeEach(() => { listServices.mockClear(); });

describe('GET /api/services token scope (#2899)', () => {
  it('accepts a valid read-scoped Bearer token and returns the service list', async () => {
    const res = await call(GET, 'GET', bearer(minted.read.secret));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((s: { name: string }) => s.name === 'immich')).toBe(true);
    expect(listServices).toHaveBeenCalledWith('Local');
  });

  it('401s a malformed / unknown Bearer token', async () => {
    const res = await call(GET, 'GET', bearer('sb_deadbeef_notarealsecret'));
    expect(res.status).toBe(401);
    expect(listServices).not.toHaveBeenCalled();
  });

  it('401s a garbage Bearer that is not even token-shaped', async () => {
    const res = await call(GET, 'GET', bearer('not-a-token'));
    expect(res.status).toBe(401);
    expect(listServices).not.toHaveBeenCalled();
  });

  it('401s an expired read-scoped token', async () => {
    const res = await call(GET, 'GET', bearer(minted.expired.secret));
    expect(res.status).toBe(401);
    expect(listServices).not.toHaveBeenCalled();
  });

  it('401s a live token that lacks the read scope (no fall-through to the cookie)', async () => {
    const res = await call(GET, 'GET', bearer(minted.mutate.secret));
    expect(res.status).toBe(401);
    expect(listServices).not.toHaveBeenCalled();
  });

  it('401s a request with no credential at all — the route did not become public', async () => {
    const res = await call(GET, 'GET');
    expect(res.status).toBe(401);
    expect(listServices).not.toHaveBeenCalled();
  });
});

describe('POST /api/services auth semantics are unchanged (#2899)', () => {
  it('still refuses a read-scoped Bearer — it carries no tokenScope', async () => {
    const res = await call(POST, 'POST', bearer(minted.read.secret));
    expect(res.status).toBe(401);
  });

  it('still refuses a mutate-scoped Bearer — cookie/internal-token only', async () => {
    const res = await call(POST, 'POST', bearer(minted.mutate.secret));
    expect(res.status).toBe(401);
  });

  it('still refuses an unauthenticated POST', async () => {
    const res = await call(POST, 'POST');
    expect(res.status).toBe(401);
  });
});
