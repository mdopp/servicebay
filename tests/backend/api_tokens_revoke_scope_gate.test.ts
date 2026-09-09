// @vitest-environment node
/**
 * A `read`-only principal may not revoke a credential — single or bulk, on
 * either token path (#2944, SECURITY).
 *
 * #2919 closed the mint and left the destroy side of the same two files wide
 * open: `DELETE /api/system/{api,mcp}-tokens` and the bulk
 * `POST /api/system/api-tokens/revoke` declared no scope, so the wrapper's gate
 * asked only "is this caller authenticated". A `read`-only `sb_` token — the
 * tier documented as safe to hand out, and the one delegated to agent
 * containers — IS authenticated once it is traded for a cookie at
 * `POST /api/auth/session-from-token`, and could then delete every token on the
 * box in one request. Denial of service against the whole box's automation,
 * plus a free way to strand the operator's own session, from the weakest
 * credential ServiceBay issues.
 *
 * These tests drive the REAL routes against the REAL token store on a throwaway
 * DATA_DIR, through the REAL bridge, for the same reason the #2919 tests do: the
 * hole lived in the seam between the three, and a mocked `requireSession` would
 * pass identically before and after the fix.
 *
 * No token value is ever hard-coded — every secret here is minted at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';

process.env.AUTH_SECRET = 'x'.repeat(48);

const dataDir = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/sb-revoke-gate-${process.pid}-${Date.now()}`,
);
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DELETE as REVOKE_ONE, GET as LIST } from '@/app/api/system/api-tokens/route';
import { DELETE as REVOKE_ONE_ALIAS, GET as LIST_ALIAS } from '@/app/api/system/mcp-tokens/route';
import { POST as REVOKE_BULK } from '@/app/api/system/api-tokens/revoke/route';
import { POST as BRIDGE } from '@/app/api/auth/session-from-token/route';
import { encryptSession } from '@/lib/auth/session';
import type { ApiScope } from '@/lib/auth/apiScope';

const secrets: Record<string, string> = {};
/** A password/UI login: no `scopes` on the session ⇒ "all scopes". */
let adminCookie = '';

async function mintToken(name: string, scopes: ApiScope[]): Promise<string> {
  const { createToken } = await import('@/lib/auth/apiTokens');
  return (await createToken({ name, scopes, createdBy: 'test' })).secret;
}

/** A throwaway token for an attacker to aim at. Returns its id. */
async function victim(): Promise<string> {
  const { createToken } = await import('@/lib/auth/apiTokens');
  const { token } = await createToken({
    name: `victim-${Math.random().toString(36).slice(2, 8)}`,
    scopes: ['read'],
    createdBy: 'test',
  });
  return token.id;
}

async function isLive(id: string): Promise<boolean> {
  const { listTokens } = await import('@/lib/auth/apiTokens');
  return (await listTokens()).some(t => t.id === id);
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

function revokeOne(handler: typeof REVOKE_ONE, id: string, headers: Record<string, string>) {
  return handler(new NextRequest(`http://test/api/system/api-tokens?id=${id}`, {
    method: 'DELETE',
    headers,
  }));
}

function revokeBulk(ids: string[], headers: Record<string, string>) {
  return REVOKE_BULK(new NextRequest('http://test/api/system/api-tokens/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ids }),
  }));
}

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  secrets.read = await mintToken('test-read', ['read']);
  secrets.destroy = await mintToken('test-destroy', ['read', 'destroy']);
  secrets.propose = await mintToken('test-propose', ['propose']);
  adminCookie = `session=${await encryptSession({
    user: 'admin', expires: new Date(Date.now() + 3_600_000),
  })}`;
});

afterAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('a read-scoped caller cannot revoke a token (#2944)', () => {
  it('refuses the single revoke on /api/system/api-tokens and the token survives', async () => {
    const cookie = await bridgeToCookie(secrets.read);
    const id = await victim();
    const res = await revokeOne(REVOKE_ONE, id, { cookie });
    expect(res.status).toBe(403);
    expect(await isLive(id)).toBe(true);
  });

  it('refuses the single revoke on the mcp-tokens alias too', async () => {
    // The alias is the same handler behind a second path; #2919's fix had to be
    // applied twice for the same reason, and a fix to one file only is exactly
    // the miss this unit exists to close.
    const cookie = await bridgeToCookie(secrets.read);
    const id = await victim();
    const res = await revokeOne(REVOKE_ONE_ALIAS, id, { cookie });
    expect(res.status).toBe(403);
    expect(await isLive(id)).toBe(true);
  });

  it('refuses the bulk revoke and leaves every listed token alive', async () => {
    const cookie = await bridgeToCookie(secrets.read);
    const ids = [await victim(), await victim(), await victim()];
    const res = await revokeBulk(ids, { cookie });
    expect(res.status).toBe(403);
    for (const id of ids) expect(await isLive(id)).toBe(true);
  });

  it('cannot escape the hold by presenting the token as a Bearer instead', async () => {
    // The routes stay cookie/internal-only: no `tokenScope`, so a raw Bearer is
    // ignored and falls through to the (absent) cookie. A `destroy` token — which
    // WOULD satisfy the scope — is used here so the 401 proves the Bearer branch
    // is shut, not that the scope was too low.
    const id = await victim();
    const res = await revokeOne(REVOKE_ONE, id, { authorization: `Bearer ${secrets.destroy}` });
    expect(res.status).toBe(401);
    expect(await isLive(id)).toBe(true);

    const bulk = await revokeBulk([id], { authorization: `Bearer ${secrets.destroy}` });
    expect(bulk.status).toBe(401);
    expect(await isLive(id)).toBe(true);
  });
});

describe('the hold refuses the under-scoped caller and nobody else (#2944)', () => {
  it('a destroy-scoped bridged session still revokes, single and bulk', async () => {
    // The denominator: without this the tests above would pass just as well on a
    // route that refuses everyone.
    const cookie = await bridgeToCookie(secrets.destroy);
    const one = await victim();
    expect((await revokeOne(REVOKE_ONE, one, { cookie })).status).toBe(200);
    expect(await isLive(one)).toBe(false);

    const many = [await victim(), await victim()];
    expect((await revokeBulk(many, { cookie })).status).toBe(200);
    for (const id of many) expect(await isLive(id)).toBe(false);
  });

  it('a password/UI session is untouched — no scopes on the cookie means all scopes', async () => {
    const id = await victim();
    expect((await revokeOne(REVOKE_ONE_ALIAS, id, { cookie: adminCookie })).status).toBe(200);
    expect(await isLive(id)).toBe(false);
  });
});

describe('enumerating token metadata (#2944, criterion 2)', () => {
  it('a read principal MAY still list tokens — deliberate, and the rows carry no secret', async () => {
    // Recorded decision, not an oversight: `listTokens` returns `publicView`
    // (no hash), the Settings → Security read-only view and the hygiene summary
    // are built from it, and with every write verb above held to mutate/destroy
    // the list confers no authority.
    const cookie = await bridgeToCookie(secrets.read);
    for (const handler of [LIST, LIST_ALIAS]) {
      const res = await handler(new NextRequest('http://test/api/system/api-tokens', {
        method: 'GET', headers: { cookie },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.tokens)).toBe(true);
      expect(JSON.stringify(body.tokens)).not.toMatch(/"hash"/);
    }
  });

  it('an off-ladder principal may not inventory the box\'s credentials', async () => {
    // `propose` is independent of the read<…<exec ladder (#2326) and implies
    // nothing, so a propose-only token now gets 403 instead of the full list.
    const cookie = await bridgeToCookie(secrets.propose);
    const res = await LIST(new NextRequest('http://test/api/system/api-tokens', {
      method: 'GET', headers: { cookie },
    }));
    expect(res.status).toBe(403);
  });
});
