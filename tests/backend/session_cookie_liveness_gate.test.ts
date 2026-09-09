// @vitest-environment node
/**
 * Class-level enforcement (#2931, SECURITY): EVERY surface that accepts the
 * ServiceBay session cookie re-checks that the session is still alive —
 * `viaToken` liveness AND the computed expiry — not just `/api/*`.
 *
 * #2047 gave a bridged session cascading revocation and tested it on
 * `requireSession`. That test passed while the hole stayed open, because
 * `requireSession` only gates `/api/*`: the `/mcp` endpoint, the Socket.IO
 * handshake and the `proxy.ts` gate each read the cookie themselves and trusted
 * the signature alone. Revoke a compromised agent's token and its cookie kept
 * driving MCP tools at that token's full scopes for the rest of the JWT's life.
 * Separately, the bridge's computed `expires` (`min(now+1h, token.expiresAt)`)
 * landed only in the payload and the cookie attribute — `encryptSession`
 * hard-coded a 24h `exp`, so nothing enforced it.
 *
 * Hence a test of the CLASS, in two halves:
 *
 *  1. **Behavioural** — the same three dead-credential shapes are driven
 *     against every surface in `SURFACES`, through the REAL token store on a
 *     throwaway DATA_DIR and the REAL bridge route. A surface that starts
 *     trusting the signature again goes red here.
 *  2. **Structural** — a source scan asserting that `getSessionFromCookieHeader`
 *     is the ONLY way a cookie becomes a principal: no file may read the
 *     `session` cookie by hand or call `decrypt` on it, and the set of files
 *     that call the chokepoint must equal `EXPECTED_SURFACES`. A new route that
 *     rolls its own cookie read fails the scan by name; a new legitimate
 *     surface must be registered here, where its liveness story is reviewed.
 *
 * `/mcp` and Socket.IO live in `packages/backend/src/server.ts`, which boots a
 * listening server on import and cannot be exercised in-process. Their entry is
 * the chokepoint call itself, plus the structural assertion below that both
 * sites obtain their cookie principal from it and from nothing else — the
 * "is this caller authenticated" branch on the result is unchanged.
 *
 * No credential value is hard-coded: every token here is minted at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

process.env.AUTH_SECRET = 'y'.repeat(48);

const dataDir = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/sb-session-liveness-${process.pid}-${Date.now()}`,
);
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as BRIDGE } from '@/app/api/auth/session-from-token/route';
import { GET as ME } from '@/app/api/auth/me/route';
import { proxy } from '@/proxy';
import { requireSession } from '@/lib/api/requireSession';
import {
  encryptSession,
  getSessionFromCookieHeader,
  MAX_SESSION_LIFETIME_MS,
} from '@/lib/auth/session';
import type { ApiScope } from '@/lib/auth/apiScope';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOTS = [
  path.join(REPO_ROOT, 'packages', 'backend', 'src'),
  path.join(REPO_ROOT, 'packages', 'frontend', 'src'),
];
/** The chokepoint itself — the one file allowed to turn a cookie into a session. */
const CHOKEPOINT = path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib', 'auth', 'session.ts');

/**
 * Every file that may accept the session cookie, and why. Adding one is a
 * security decision: the surface inherits the liveness rules by going through
 * `getSessionFromCookieHeader`, and it must appear in `SURFACES` below (or say
 * here why it cannot be driven in-process).
 */
const EXPECTED_SURFACES: Record<string, string> = {
  'packages/backend/src/lib/api/requireSession.ts': 'the /api/* route gate',
  'packages/backend/src/server.ts': 'the custom server: the /mcp cookie branch AND the Socket.IO handshake',
  'packages/frontend/src/app/api/auth/me/route.ts': 'current-user introspection, a public GET that self-gates',
  'packages/frontend/src/proxy.ts': 'the request gate in front of /api/* and every page path',
};

// ---------------------------------------------------------------- fixtures

async function mint(name: string, scopes: ApiScope[], expiresAt?: string) {
  const { createToken } = await import('@/lib/auth/apiTokens');
  return await createToken({ name, scopes, createdBy: 'test', ...(expiresAt ? { expiresAt } : {}) });
}

/** Trade a token secret for a bridged session cookie — the repro's step 1. */
async function bridgeToCookie(secret: string): Promise<string> {
  const res = await BRIDGE(new NextRequest('http://test/api/auth/session-from-token', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(res.status).toBe(200);
  const value = /(?:^|,\s*)session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  expect(value, 'the bridge did not set a session cookie').toBeTruthy();
  return `session=${value}`;
}

/** Claims of a session cookie header, read without verifying (payload only). */
function claimsOf(cookieHeader: string): Record<string, unknown> {
  const jwt = /session=([^;]+)/.exec(cookieHeader)![1];
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

/**
 * Every surface that turns the session cookie into a principal, as a uniform
 * "does this cookie still get in?" probe.
 */
const SURFACES: { name: string; accepts: (cookie: string) => Promise<boolean> }[] = [
  {
    name: '/api/* — requireSession',
    accepts: async (cookie) => {
      const r = await requireSession(new Request('http://test/api/services', { headers: { cookie } }));
      return !(r instanceof NextResponse);
    },
  },
  {
    name: 'proxy.ts — the gate in front of /api/* and every page path',
    accepts: async (cookie) => {
      const res = await proxy(new NextRequest('http://test/api/services', {
        method: 'GET',
        headers: { cookie },
      }));
      return res.status !== 401;
    },
  },
  {
    name: 'GET /api/auth/me — the self-gating public route',
    accepts: async (cookie) => {
      const res = await ME(new NextRequest('http://test/api/auth/me', { headers: { cookie } }));
      return (await res.json()).authenticated === true;
    },
  },
  {
    name: '/mcp + Socket.IO — server.ts, via the chokepoint it calls',
    accepts: async (cookie) => (await getSessionFromCookieHeader(cookie)) !== null,
  },
];

/** A password/UI login: no `viaToken`, no `scopes` ⇒ all scopes (#1264). */
let adminCookie = '';

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  adminCookie = `session=${await encryptSession({
    user: 'admin',
    expires: new Date(Date.now() + MAX_SESSION_LIFETIME_MS),
  })}`;
});

afterAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

// ------------------------------------------------------- criteria 1 and 2

describe('#2931 — a dead credential is refused on EVERY cookie surface', () => {
  it.each(SURFACES)('$name accepts a live bridged session', async ({ accepts }) => {
    const { secret } = await mint(`live-${Math.random().toString(36).slice(2, 8)}`, ['read']);
    expect(await accepts(await bridgeToCookie(secret))).toBe(true);
  });

  it.each(SURFACES)('$name refuses it once the source token is REVOKED', async ({ accepts }) => {
    const { token, secret } = await mint(`doomed-${Math.random().toString(36).slice(2, 8)}`, ['read']);
    const cookie = await bridgeToCookie(secret);
    expect(await accepts(cookie), 'precondition: live before the revoke').toBe(true);

    const { revokeToken } = await import('@/lib/auth/apiTokens');
    await revokeToken(token.id);

    expect(await accepts(cookie)).toBe(false);
  });

  it.each(SURFACES)('$name refuses it once the source token has EXPIRED', async ({ accepts }) => {
    // A cookie minted while the token was still live, presented after the token
    // lapsed — the "let a 10-minute token lapse" half of the repro.
    const { token } = await mint(
      `lapsed-${Math.random().toString(36).slice(2, 8)}`,
      ['read'],
      new Date(Date.now() - 60_000).toISOString(),
    );
    const cookie = `session=${await encryptSession({
      user: `token:${token.name}`,
      expires: new Date(Date.now() + 3_600_000),
      scopes: ['read'],
      viaToken: token.id,
    })}`;
    expect(await accepts(cookie)).toBe(false);
  });

  it.each(SURFACES)('$name refuses a session past its COMPUTED expiry', async ({ accepts }) => {
    // The pre-fix cookie shape: a live token, a short computed `expires`, and a
    // full 24h `exp` signed over it. The signature verifies; the session is dead.
    const { token } = await mint(`stale-${Math.random().toString(36).slice(2, 8)}`, ['read']);
    const { SignJWT } = await import('jose');
    const jwt = await new SignJWT({
      user: `token:${token.name}`,
      expires: new Date(Date.now() - 1_000).toISOString(),
      scopes: ['read'],
      viaToken: token.id,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
    expect(await accepts(`session=${jwt}`)).toBe(false);
  });
});

describe('#2931 — the computed expiry binds into the signed exp', () => {
  it('caps a bridged cookie at the bridge s 1h, not at 24h', async () => {
    const { secret } = await mint('short-lived', ['read']);
    const claims = claimsOf(await bridgeToCookie(secret));
    const expMs = (claims.exp as number) * 1000;
    // The bridge computes min(now+1h, token.expiresAt); this token never
    // expires, so the 1h cap is what must land in `exp`.
    expect(expMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 2_000);
    expect(expMs).toBeLessThan(Date.now() + MAX_SESSION_LIFETIME_MS - 60_000);
    expect(expMs).toBe(Math.ceil(Date.parse(claims.expires as string) / 1000) * 1000);
  });

  it('caps a bridged cookie at the source token s own expiry when that is sooner', async () => {
    const tokenExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { secret } = await mint('ten-minute', ['read'], tokenExpiry);
    const claims = claimsOf(await bridgeToCookie(secret));
    expect((claims.exp as number) * 1000).toBeLessThanOrEqual(Date.parse(tokenExpiry) + 1_000);
  });

  it('still gives an expiry-less payload the 24h ceiling', async () => {
    const jwt = await encryptSession({ user: 'admin' });
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const expMs = (claims.exp as number) * 1000;
    expect(expMs).toBeGreaterThan(Date.now() + MAX_SESSION_LIFETIME_MS - 60_000);
    expect(expMs).toBeLessThanOrEqual(Date.now() + MAX_SESSION_LIFETIME_MS + 1_000);
  });
});

// ------------------------------------------------------------- criterion 4

describe('#2931 — an ordinary password login is untouched', () => {
  it.each(SURFACES)('$name still accepts the admin cookie login', async ({ accepts }) => {
    expect(await accepts(adminCookie)).toBe(true);
  });

  it('keeps the admin session scope-less, which means ALL scopes', async () => {
    const session = await getSessionFromCookieHeader(adminCookie);
    expect(session?.user).toBe('admin');
    // Omitted == all (#1264). A liveness check must not start narrowing this.
    expect(session?.scopes).toBeUndefined();
    expect(session?.viaToken).toBeUndefined();
  });

  it('reports the admin login as a session-sourced user on /api/auth/me', async () => {
    const res = await ME(new NextRequest('http://test/api/auth/me', { headers: { cookie: adminCookie } }));
    expect(await res.json()).toMatchObject({
      authenticated: true, username: 'admin', source: 'session',
    });
  });

  it('leaves the /mcp operator scope set for a scope-less cookie intact', async () => {
    // The admin cookie's scopes over /mcp come from server.ts's fallback for a
    // scope-less session. Pinned here so a liveness change cannot quietly
    // narrow (or widen) what a normal login reaches on the MCP surface.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'backend', 'src', 'server.ts'), 'utf8');
    const fallback = /scopes:\s*session\.scopes\s*\?\?\s*\[([^\]]*)\]/.exec(src)?.[1];
    expect(fallback, 'server.ts no longer derives /mcp scopes from the cookie session').toBeTruthy();
    const scopes = fallback!.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect(scopes).toEqual(['read', 'lifecycle', 'mutate', 'destroy', 'propose']);
    // `exec` stays absent (#2623) — asserted here because this is now the one
    // test that reads the fallback.
    expect(scopes).not.toContain('exec');
  });
});

// ------------------------------------------------------------- criterion 3

/** Reading the `session` cookie out of a request by hand. */
const BY_HAND_COOKIE_READ = /(?:cookies\(\)|\.cookies|cookieStore)\s*\??\.\s*get\(\s*['"]session['"]\s*\)/;
/** Importing the raw JWT verifier from the session module — it skips liveness. */
const RAW_DECRYPT_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\b(?:decrypt|readSessionCookie)\b[^}]*\}\s*from\s*['"][^'"]*(?:auth\/session|lib\/auth)['"]/;
const CHOKEPOINT_CALL = /\bgetSessionFromCookieHeader\s*\(/;

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

function sourceFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const root of SRC_ROOTS) {
    for (const full of walk(root)) {
      if (full === CHOKEPOINT) continue;
      out.push({ rel: path.relative(REPO_ROOT, full), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('#2931 — the chokepoint is the only cookie→principal path', () => {
  it('has exactly the registered set of cookie surfaces, no more and no fewer', () => {
    const found = sourceFiles()
      .filter(f => CHOKEPOINT_CALL.test(f.text))
      .map(f => f.rel)
      .sort();
    // Both directions on purpose: an unregistered new surface fails (nobody
    // reviewed its liveness story), and a registered surface that stopped
    // calling the chokepoint fails too (that is the #2931 regression itself).
    expect(found).toEqual(Object.keys(EXPECTED_SURFACES).sort());
  });

  it('lets no file read the session cookie or decrypt it by hand', () => {
    const offenders = sourceFiles()
      .filter(f => BY_HAND_COOKIE_READ.test(f.text) || RAW_DECRYPT_IMPORT.test(f.text))
      .map(f => f.rel);
    expect(
      offenders,
      'these files turn the session cookie into a principal without the liveness re-check — '
      + 'call getSessionFromCookieHeader instead',
    ).toEqual([]);
  });

  it('takes both of server.ts s cookie surfaces through the chokepoint', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'backend', 'src', 'server.ts'), 'utf8');
    // The /mcp branch and the Socket.IO handshake — two call sites, one gate.
    expect(src.match(new RegExp(CHOKEPOINT_CALL.source, 'g')) ?? []).toHaveLength(2);
  });

  it('keeps the liveness re-check inside the chokepoint', () => {
    const src = fs.readFileSync(CHOKEPOINT, 'utf8');
    const body = /export async function getSessionFromCookieHeader\([\s\S]*?\n}/.exec(src)?.[0];
    expect(body, 'getSessionFromCookieHeader is gone or renamed').toBeTruthy();
    expect(body).toMatch(/sessionIsLive\(/);
    expect(src).toMatch(/tokenIsLive\(/);
  });
});
