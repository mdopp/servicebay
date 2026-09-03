// @vitest-environment node
// jose's HS256 key check is `instanceof Uint8Array`, which fails across the
// jsdom realm — the real session crypto only signs under the node environment
// (same pragma as tests/backend/auth_session.test.ts).
/**
 * Token → session bridge scope containment (#2768, SECURITY).
 *
 * `POST /api/auth/session-from-token` trades a Bearer token for a session
 * cookie carrying `scopes = token.scopes`, and its docblock promises "a `read`-
 * only token yields a read-only session — mutating endpoints still reject it."
 * Until #2768 that promise was false: `requireSession`'s cookie branch returned
 * the session as-is and never compared `session.scopes` to `options.tokenScope`,
 * so a `read` token could be laundered into a cookie that drove a
 * `tokenScope: 'destroy'` route.
 *
 * This is the end-to-end assertion, with the REAL session crypto: mint the
 * cookie through the actual route, then feed that exact cookie to the actual
 * `requireSession`.
 */
// Must be set before `@/lib/auth/session` derives (and caches) its key.
process.env.AUTH_SECRET = 'test-auth-secret-for-2768-bridge-scope';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  tokenIsLive: vi.fn(),
}));

vi.mock('@/lib/auth/apiTokens', () => ({
  verifyToken: mocks.verifyToken,
  tokenIsLive: mocks.tokenIsLive,
}));

import { POST } from './route';
import { requireSession } from '@/lib/api/requireSession';

const READ_ONLY_TOKEN = { id: 'a1b2c3d4', name: 'readonly', scopes: ['read'] };

/** Drive the real bridge route and return the `session` cookie it set. */
async function mintBridgedCookie(token: typeof READ_ONLY_TOKEN): Promise<string> {
  mocks.verifyToken.mockResolvedValueOnce(token);
  const res = await POST(
    new NextRequest('http://localhost:5888/api/auth/session-from-token', {
      method: 'POST',
      headers: { authorization: 'Bearer sb_a1b2c3d4_SECRET' },
    }),
  );
  expect(res.status).toBe(200);
  // Read the wire `Set-Cookie` — the handler's declared return type is a plain
  // Response, and the header is what a browser would actually carry back.
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /(?:^|,\s*)session=([^;]+)/.exec(setCookie);
  expect(match, 'the bridge must set a session cookie').not.toBeNull();
  return decodeURIComponent(match![1]);
}

const withCookie = (cookie: string) =>
  new Request('http://localhost:5888/api/settings/backups/restore', {
    method: 'POST',
    headers: { cookie: `session=${encodeURIComponent(cookie)}` },
  });

describe('bridged session is held to its source token scopes (#2768)', () => {
  beforeEach(() => {
    mocks.verifyToken.mockReset();
    mocks.tokenIsLive.mockReset();
    // The source token is live throughout — the rejection under test must come
    // from the scope check, not from cascading revocation (#2047).
    mocks.tokenIsLive.mockResolvedValue(true);
  });

  it('mints a cookie carrying exactly the token scopes', async () => {
    const cookie = await mintBridgedCookie(READ_ONLY_TOKEN);
    const auth = await requireSession(withCookie(cookie));
    expect(auth instanceof NextResponse).toBe(false);
    expect((auth as { user: string }).user).toBe('token:readonly');
    expect((auth as { scopes?: string[] }).scopes).toEqual(['read']);
  });

  it('REJECTS the read-only bridged cookie on a tokenScope:destroy route', async () => {
    const cookie = await mintBridgedCookie(READ_ONLY_TOKEN);
    const auth = await requireSession(withCookie(cookie), { tokenScope: 'destroy' });
    expect(auth instanceof NextResponse).toBe(true);
    expect((auth as NextResponse).status).toBe(403);
  });

  it('REJECTS it on a tokenScope:mutate route too', async () => {
    const cookie = await mintBridgedCookie(READ_ONLY_TOKEN);
    const auth = await requireSession(withCookie(cookie), { tokenScope: 'mutate' });
    expect(auth instanceof NextResponse).toBe(true);
    expect((auth as NextResponse).status).toBe(403);
  });

  it('still admits it on a tokenScope:read route (the scope it does hold)', async () => {
    const cookie = await mintBridgedCookie(READ_ONLY_TOKEN);
    const auth = await requireSession(withCookie(cookie), { tokenScope: 'read' });
    expect(auth instanceof NextResponse).toBe(false);
    expect((auth as { user: string }).user).toBe('token:readonly');
  });

  it('admits a destroy-scoped bridged cookie on the same destroy route', async () => {
    const cookie = await mintBridgedCookie({
      id: 'a1b2c3d4',
      name: 'readonly',
      scopes: ['read', 'destroy'],
    });
    const auth = await requireSession(withCookie(cookie), { tokenScope: 'destroy' });
    expect(auth instanceof NextResponse).toBe(false);
  });
});
