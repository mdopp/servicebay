// @vitest-environment node
/**
 * `POST /api/system/api-tokens` may not mint a token more privileged than its
 * caller (#2919, SECURITY — privilege escalation).
 *
 * The hole: `createTokenHandler` passed `body.scopes` straight to `createToken`
 * without ever comparing them to the caller's own scopes, and both mint routes
 * declared no scope at all — so `cookieScopeRefusal` (#2768) short-circuited on
 * the `!tokenScope` branch and never ran. A `read`-only `sb_` token, the tier
 * documented as safe to hand out and the one delegated to agent containers,
 * became `exec`/`destroy` in two requests: bridge it to a cookie at
 * `POST /api/auth/session-from-token`, then mint whatever you like.
 *
 * These tests drive the REAL routes against the REAL token store on a throwaway
 * DATA_DIR, and the REAL bridge — because the bug lived exactly in the seam
 * between the three. A mocked `requireSession` would have passed both before and
 * after the fix (that is how the guarded twin, `createDelegatedToken`'s child ⊆
 * parent check from #2048, ended up with an unguarded sibling in the same file).
 *
 * No token value is ever hard-coded — every secret here is minted at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';

// jose needs a key before the first encrypt/decrypt; the module reads it
// lazily, so setting it here (before any test body runs) is enough.
process.env.AUTH_SECRET = 'x'.repeat(48);

// Real token store, real verifyToken — on a temp DATA_DIR. Set before any
// import so `apiTokens`'s module-level TOKENS_FILE resolves under it.
// `vi.hoisted` so the path exists before the mock factory below is evaluated —
// `apiTokens` resolves TOKENS_FILE at module load. The directory itself is made
// in `beforeAll`; only the name has to be hoisted.
const dataDir = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/sb-mint-subset-${process.pid}-${Date.now()}`,
);
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The first user-minted token retires the bootstrap bridge (#322) — that writes
// config and is not what these tests are about.
vi.mock('@/lib/mcp/bootstrapToken', () => ({
  revokeBootstrapToken: vi.fn(async () => {}),
}));

import { POST as MINT } from '@/app/api/system/api-tokens/route';
import { POST as MINT_ALIAS } from '@/app/api/system/mcp-tokens/route';
import { POST as BRIDGE } from '@/app/api/auth/session-from-token/route';
import { encryptSession } from '@/lib/auth/session';
import type { ApiScope } from '@/lib/auth/apiScope';

const secrets: Record<string, string> = {};
/** A password/UI login: no `scopes` on the session ⇒ "all scopes". */
let adminCookie = '';

/** Trade a token secret for a bridged session cookie — the repro's step 1. */
async function bridgeToCookie(secret: string): Promise<string> {
  const res = await BRIDGE(new NextRequest('http://test/api/auth/session-from-token', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const value = /(?:^|,\s*)session=([^;]+)/.exec(setCookie)?.[1];
  expect(value, 'the bridge did not set a session cookie').toBeTruthy();
  return `session=${value}`;
}

/** The repro's step 2 — mint through either route with a cookie. */
function mint(
  handler: typeof MINT,
  cookie: string,
  scopes: ApiScope[],
  extra: Record<string, unknown> = {},
) {
  return handler(new NextRequest('http://test/api/system/api-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `probe-${scopes.join('-')}`, scopes, ...extra }),
  }));
}

async function tokenCount(): Promise<number> {
  const { listTokens } = await import('@/lib/auth/apiTokens');
  return (await listTokens()).length;
}

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  const { createToken } = await import('@/lib/auth/apiTokens');
  const mk = async (name: string, scopes: ApiScope[]) =>
    (await createToken({ name, scopes, createdBy: 'test' })).secret;
  secrets.read = await mk('test-read', ['read']);
  secrets.mutate = await mk('test-mutate', ['mutate']);
  secrets.destroy = await mk('test-destroy', ['mutate', 'destroy']);
  adminCookie = `session=${await encryptSession({
    user: 'admin', expires: new Date(Date.now() + 3_600_000),
  })}`;
});

afterAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('a read-scoped caller cannot mint a more privileged token (#2919)', () => {
  it('refuses exec on /api/system/api-tokens and mints nothing', async () => {
    const cookie = await bridgeToCookie(secrets.read);
    const before = await tokenCount();
    const res = await mint(MINT, cookie, ['exec']);
    expect(res.status).toBe(403);
    expect(await tokenCount()).toBe(before);
  });

  it('refuses destroy on /api/system/api-tokens', async () => {
    const cookie = await bridgeToCookie(secrets.read);
    const res = await mint(MINT, cookie, ['destroy']);
    expect(res.status).toBe(403);
  });

  it('refuses exec+destroy on the /api/system/mcp-tokens alias too', async () => {
    const cookie = await bridgeToCookie(secrets.read);
    const before = await tokenCount();
    const res = await mint(MINT_ALIAS, cookie, ['exec', 'destroy']);
    expect(res.status).toBe(403);
    expect(await tokenCount()).toBe(before);
  });

  it('cannot even mint a same-scoped `read` twin — minting needs `mutate`', async () => {
    // The residual escalation a pure subset check would leave open: an
    // unparented `read` token with a fresh, arbitrarily long TTL, outside the
    // delegation chain's TTL narrowing and cascading revocation (#2047/#2048).
    const cookie = await bridgeToCookie(secrets.read);
    const before = await tokenCount();
    const res = await mint(MINT, cookie, ['read']);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/mutate/);
    expect(await tokenCount()).toBe(before);
  });
});

describe('the mint is held to the caller\'s own scopes (#2919)', () => {
  it('refuses exec to a mutate-scoped caller and NAMES the missing scope', async () => {
    const cookie = await bridgeToCookie(secrets.mutate);
    const res = await mint(MINT, cookie, ['exec']);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/exec/);
  });

  it('names every missing scope, not just the first', async () => {
    const cookie = await bridgeToCookie(secrets.mutate);
    const res = await mint(MINT, cookie, ['mutate', 'exec', 'destroy']);
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error).toMatch(/exec/);
    expect(error).toMatch(/destroy/);
  });

  it('allows a mutate-scoped caller to mint within its own authority', async () => {
    const cookie = await bridgeToCookie(secrets.mutate);
    const res = await mint(MINT, cookie, ['mutate']);
    expect(res.status).toBe(200);
    expect((await res.json()).secret).toMatch(/^sb_/);
  });

  it('reuses apiScope.ts implication: a destroy caller may mint reboot', async () => {
    const cookie = await bridgeToCookie(secrets.destroy);
    const res = await mint(MINT, cookie, ['reboot']);
    expect(res.status).toBe(200);
  });

  it('reuses apiScope.ts implication: a destroy caller may NOT mint exec (#2623)', async () => {
    const cookie = await bridgeToCookie(secrets.destroy);
    const res = await mint(MINT, cookie, ['exec']);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/exec/);
  });
});

describe('an admin session keeps full minting power (#2919)', () => {
  it('mints exec+destroy from a password session on /api/system/api-tokens', async () => {
    const res = await mint(MINT, adminCookie, ['exec', 'destroy']);
    expect(res.status).toBe(200);
    expect((await res.json()).secret).toMatch(/^sb_/);
  });

  it('mints exec+destroy from a password session on the alias too', async () => {
    const res = await mint(MINT_ALIAS, adminCookie, ['exec', 'destroy']);
    expect(res.status).toBe(200);
  });

  it('still enforces the never-expires read-only guard (#2299) unchanged', async () => {
    const res = await mint(MINT, adminCookie, ['destroy'], { neverExpires: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/never-expiring/i);
  });
});

describe('the mint route did not become Bearer-reachable (#2919)', () => {
  // `cookieScope`, not `tokenScope`, precisely so this stays true: a token that
  // could call the mint directly would hand itself an unparented, longer-lived
  // twin, bypassing /delegate's TTL narrowing.
  it.each(['read', 'mutate', 'destroy'])('401s a %s-scoped Bearer', async (which) => {
    const before = await tokenCount();
    const res = await MINT(new NextRequest('http://test/api/system/api-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets[which]}` },
      body: JSON.stringify({ name: 'bearer-probe', scopes: ['read'] }),
    }));
    expect(res.status).toBe(401);
    expect(await tokenCount()).toBe(before);
  });

  it('401s a request with no credential at all', async () => {
    const res = await MINT(new NextRequest('http://test/api/system/api-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anon-probe', scopes: ['read'] }),
    }));
    expect(res.status).toBe(401);
  });
});
