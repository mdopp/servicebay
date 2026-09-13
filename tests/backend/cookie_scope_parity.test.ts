/**
 * CLASS GATE — a session cookie must never be the stronger of a token
 * principal's two credentials (#2958).
 *
 * `POST /api/auth/session-from-token` trades a named API token for a session
 * cookie whose principal is still that token. On the **bearer** path a route
 * that declares no `tokenScope` is unreachable — `requireSession` never opens
 * the Bearer branch. On the **cookie** path there was no equivalent floor, so
 * the same token reached more through the bridge than it could reach directly:
 * a `read`-only token's cookie could drive `POST /api/system/factory-reset`.
 * #2943 pulled two container-log routes back one at a time with a per-route
 * `cookieScope`; this file is the class-wide replacement for that patching.
 *
 * Everything here is driven from **route enumeration**, not from a hand-written
 * list of routes: the suite walks `packages/frontend/src/app/{api,napi}` for
 * `route.ts` files and reads the options off each exported handler. A route
 * added tomorrow is therefore covered by construction — it appears in the
 * enumeration, has no classification, and turns this suite red (and is refused
 * at runtime meanwhile, because `gateForTokenPrincipal` defaults to `deny`).
 *
 * Mutation-proved: adding a scopeless `POST /api/system/parity-canary` reachable
 * through the bridge turned the enumeration test and the runtime drive red; the
 * injection was reverted. See the PR body.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { ApiScope } from '@/lib/auth/apiScope';

vi.mock('@/lib/auth/session', () => ({
  getSessionFromCookieHeader: vi.fn(),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'test-internal-token-32-chars-long'),
}));
vi.mock('@/lib/auth/apiTokens', () => ({
  verifyToken: vi.fn(),
  tokenIsLive: vi.fn(async () => true),
}));

import { requireSession } from '@/lib/api/requireSession';
import { getSessionFromCookieHeader } from '@/lib/auth/session';
import {
  TOKEN_PRINCIPAL_ROUTES,
  gateForTokenPrincipal,
  type TokenPrincipalGate,
} from '@/lib/api/tokenPrincipalRoutes';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface Handler {
  method: (typeof METHODS)[number];
  /** Next.js route path with dynamic segments verbatim: `/api/services/[name]`. */
  path: string;
  /** A concrete pathname a request would actually carry. */
  concretePath: string;
  tokenScope?: ApiScope;
  cookieScope?: ApiScope;
  skipAuth: boolean;
  file: string;
}

function* walkRoutes(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkRoutes(full);
    else if (entry.isFile() && entry.name === 'route.ts') yield full;
  }
}

/**
 * Every exported route handler, with the auth options it declares.
 *
 * Read statically from source rather than by importing the modules: a route
 * module pulls in the agent manager, podman clients and the config loader, and
 * the point of the gate is to see routes that nobody wired up to a test.
 */
function enumerateHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const dir of ['api', 'napi']) {
    for (const file of walkRoutes(path.join(APP_ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf-8');
      const routePath = '/' + path.relative(APP_ROOT, file).replace(/\/route\.ts$/, '');
      for (const method of METHODS) {
        const decl = new RegExp(
          `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\s*[:=])`,
        ).exec(src);
        if (!decl) continue;
        // The options object is the first argument of the withApiHandler call,
        // within a bounded window after the export — long enough for the
        // generic parameter list and a multi-line options literal.
        const win = src.slice(decl.index, decl.index + 600);
        const scope = (name: string): ApiScope | undefined =>
          new RegExp(`${name}\\s*:\\s*'([a-z]+)'`).exec(win)?.[1] as ApiScope | undefined;
        out.push({
          method,
          path: routePath,
          concretePath: routePath.replace(/\[[^\]]+\]/g, 'x'),
          tokenScope: scope('tokenScope'),
          cookieScope: scope('cookieScope'),
          skipAuth: /skipAuth\s*:\s*true/.test(win),
          file: path.relative(REPO_ROOT, file),
        });
      }
    }
  }
  return out;
}

const HANDLERS = enumerateHandlers();

/**
 * The scope a route demands of a token principal on each of the two transports.
 * `deny` = the transport does not carry it at all, `any` = no scope demanded.
 *
 * `bearerRequirement` is `deny` for every route without `tokenScope`, because
 * `requireSession` never opens the Bearer branch there. That is *not* the same
 * as "no principal may be here" — it says the bearer transport is not offered.
 * The boundary a route actually declares is `cookieRequirement`, and the bug
 * this file gates was that the cookie path had **no** value for it at all.
 */
function bearerRequirement(h: Handler): TokenPrincipalGate {
  if (h.skipAuth) return 'any';
  return h.tokenScope ?? 'deny';
}
function cookieRequirement(h: Handler): TokenPrincipalGate {
  if (h.skipAuth) return 'any';
  return h.tokenScope ?? h.cookieScope ?? gateForTokenPrincipal(h.method, h.concretePath);
}

/** Strength order. `any` demands nothing; `deny` admits nobody. */
const STRENGTH: Record<string, number> = {
  any: 0, propose: 1, read: 1, lifecycle: 2, mutate: 3, reboot: 4, destroy: 5, exec: 6, deny: 7,
};

describe('cookie/bearer scope parity (#2958)', () => {
  it('enumerates the real route tree', () => {
    // A guard on the enumeration itself: if the walk or the regex silently
    // stops matching, every assertion below passes over an empty set — the
    // "success while doing nothing" shape.
    expect(HANDLERS.length).toBeGreaterThan(200);
    expect(HANDLERS.some(h => h.path === '/api/system/factory-reset')).toBe(true);
    expect(HANDLERS.some(h => h.tokenScope === 'read')).toBe(true);
  });

  it('every route that declares no scope carries a written classification', () => {
    const unclassified = HANDLERS
      .filter(h => !h.skipAuth && !h.tokenScope && !h.cookieScope)
      .filter(h => !TOKEN_PRINCIPAL_ROUTES.some(r => r.method === h.method && r.path === h.path))
      .map(h => `${h.method} ${h.path}  (${h.file})`);

    expect(
      unclassified,
      `${unclassified.length} route handler(s) declare no scope and carry no classification.\n` +
      'A route without a scope is not automatically safe: a bearer cannot reach it, so a\n' +
      'session cookie bridged from a token must not reach it either. Decide, in words, in\n' +
      'packages/backend/src/lib/api/tokenPrincipalRoutes.ts — `deny`, or the scope a token\n' +
      'principal must hold. Until then the route is refused at runtime (#2958).\n\n' +
      `Unclassified:\n  ${unclassified.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the classification ledger has no stale entries', () => {
    const stale = TOKEN_PRINCIPAL_ROUTES
      .filter(r => !HANDLERS.some(h =>
        h.method === r.method && h.path === r.path && !h.skipAuth && !h.tokenScope && !h.cookieScope))
      .map(r => `${r.method} ${r.path}`);
    expect(
      stale,
      'Classification entries that match no scopeless route handler — the route was removed, ' +
      'renamed, or has since declared its own scope. Drop the entry.\n\n' +
      `Stale:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every classification carries a reason', () => {
    const mute = TOKEN_PRINCIPAL_ROUTES
      .filter(r => r.reason.trim().length < 40)
      .map(r => `${r.method} ${r.path}`);
    expect(mute, `Classifications without a written reason:\n  ${mute.join('\n  ')}`).toEqual([]);
  });

  it('no route is weaker for the cookie path than for the bearer path', () => {
    // Where a route names a `tokenScope`, the two transports must demand the
    // same thing — this is the #2768 rule, re-asserted over the whole tree.
    const weaker = HANDLERS
      .filter(h => h.tokenScope !== undefined)
      .filter(h => STRENGTH[cookieRequirement(h)] < STRENGTH[bearerRequirement(h)])
      .map(h => `${h.method} ${h.path}: bearer needs ${bearerRequirement(h)}, ` +
        `cookie needs ${cookieRequirement(h)}  (${h.file})`);
    expect(
      weaker,
      'A token principal reaches these routes through the session bridge more easily than ' +
      'with its own bearer token. The cookie must never be the stronger credential (#2958).\n\n' +
      `Offenders:\n  ${weaker.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no route lets a token principal through the cookie path unchecked', () => {
    // The actual hole. On a route with no `tokenScope` the bearer transport is
    // simply not offered; the cookie transport IS, and before #2958 it applied
    // nothing at all — a `read` token's cookie could POST /api/system/factory-reset.
    // Every route must now demand *something* of a token principal, and the one
    // value that demands nothing (`any`) has to be written down deliberately.
    const unchecked = HANDLERS
      .filter(h => !h.skipAuth)
      .filter(h => cookieRequirement(h) === 'any')
      .filter(h => !TOKEN_PRINCIPAL_ROUTES.some(r =>
        r.method === h.method && r.path === h.path && r.gate === 'any'))
      .map(h => `${h.method} ${h.path}  (${h.file})`);
    expect(
      unchecked,
      'These routes admit a token principal with no scope check and no written ' +
      `decision to do so:\n  ${unchecked.join('\n  ')}`,
    ).toEqual([]);
  });

  it('nothing that changes state is classified `any`', () => {
    // `any` means "the principal is irrelevant here". That can be true of a
    // read surface an anonymous visitor already reaches; it can never be true
    // of a write.
    const writes = TOKEN_PRINCIPAL_ROUTES
      .filter(r => r.gate === 'any' && r.method !== 'GET')
      .map(r => `${r.method} ${r.path}`);
    expect(
      writes,
      `Mutating routes classified as needing no scope at all:\n  ${writes.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * The same property, driven through the real `requireSession` rather than
 * through the enumeration's arithmetic — the enumeration says what the routes
 * declare, this says what the gate actually does with it.
 */
describe('cookie/bearer scope parity, driven through requireSession (#2958)', () => {
  const mockCookie = getSessionFromCookieHeader as unknown as {
    mockReset: () => void;
    mockResolvedValue: (v: unknown) => void;
  };
  beforeEach(() => mockCookie.mockReset());

  const call = async (h: Handler, options: { tokenScope?: ApiScope; cookieScope?: ApiScope }) =>
    requireSession(
      new Request(`http://box.test${h.concretePath}`, {
        method: h.method,
        headers: { cookie: 'session=synthetic' },
      }),
      options,
    );

  const gated = HANDLERS.filter(h => !h.skipAuth);
  const routeOptions = (h: Handler) => ({ tokenScope: h.tokenScope, cookieScope: h.cookieScope });

  it('refuses a bridged cookie holding no useful scope on every route but the `any` ones', async () => {
    // `propose` is a real scope that sits off the read<…<exec ladder entirely,
    // so it satisfies nothing — the weakest token principal that can exist.
    mockCookie.mockResolvedValue({
      user: 'token:weakest',
      expires: new Date(Date.now() + 60_000),
      scopes: ['propose'] as ApiScope[],
      viaToken: 'aaaaaaaa',
    });
    const admitted: string[] = [];
    for (const h of gated) {
      const result = await call(h, routeOptions(h));
      const ok = !(result instanceof NextResponse);
      if (ok && cookieRequirement(h) !== 'any' && cookieRequirement(h) !== 'propose') {
        admitted.push(`${h.method} ${h.path} (classified ${cookieRequirement(h)})`);
      }
      if (!ok && cookieRequirement(h) === 'any') {
        admitted.push(`${h.method} ${h.path} refused despite the 'any' classification`);
      }
    }
    expect(
      admitted,
      `The gate does not match the written classification on:\n  ${admitted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('a read-scoped bridged cookie reaches no route its bearer could not', async () => {
    mockCookie.mockResolvedValue({
      user: 'token:reader',
      expires: new Date(Date.now() + 60_000),
      scopes: ['read'] as ApiScope[],
      viaToken: 'bbbbbbbb',
    });
    const escalations: string[] = [];
    for (const h of gated) {
      const result = await call(h, routeOptions(h));
      if (result instanceof NextResponse) continue;
      // Reached by cookie. That is only legitimate where the route itself says
      // a `read` principal may be there — a declared scope it satisfies, or a
      // classification of `read`/`any`.
      const required = cookieRequirement(h);
      if (required === 'any' || required === 'read') continue;
      escalations.push(`${h.method} ${h.path} reached with only 'read' (needs ${required})`);
    }
    expect(
      escalations,
      'A `read` token traded itself a cookie and got further than its bearer would:\n  ' +
      escalations.join('\n  '),
    ).toEqual([]);
  });

  it('a password login is untouched on every route — criterion 2, asserted not assumed', async () => {
    // The operator's own session carries no `scopes`; nothing in #2958 may
    // narrow it. Same 229-handler sweep, so a future rule that forgets the
    // distinction locks the operator out here rather than on the box.
    mockCookie.mockResolvedValue({ user: 'admin', expires: new Date(Date.now() + 60_000) });
    const refused: string[] = [];
    for (const h of gated) {
      const result = await call(h, routeOptions(h));
      if (result instanceof NextResponse) refused.push(`${h.method} ${h.path} → ${result.status}`);
    }
    expect(
      refused,
      'A password-login session (no `scopes`) was refused. #2958 constrains token ' +
      `principals only:\n  ${refused.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('the classification default is refusal (#2958)', () => {
  it('an unknown route refuses a token principal without anyone writing it down', () => {
    expect(gateForTokenPrincipal('POST', '/api/system/not-a-route-yet')).toBe('deny');
    expect(gateForTokenPrincipal('GET', '/api/system/not-a-route-yet')).toBe('deny');
  });

  it('matches dynamic segments and treats HEAD as GET', () => {
    expect(gateForTokenPrincipal('GET', '/api/services/immich/status')).toBe('read');
    expect(gateForTokenPrincipal('HEAD', '/api/services/immich/status')).toBe('read');
    expect(gateForTokenPrincipal('DELETE', '/api/services/immich')).toBe('deny');
    // A dynamic segment matches exactly one path segment, never a deeper path.
    expect(gateForTokenPrincipal('GET', '/api/services/immich/deeper/status')).toBe('deny');
  });

  it('the two routes #2943 patched by hand are covered by the ledger instead', () => {
    expect(gateForTokenPrincipal('GET', '/api/containers/abc123/logs')).toBe('read');
    expect(gateForTokenPrincipal('GET', '/api/containers/abc123/logs/stream')).toBe('read');
    const source = fs.readFileSync(
      path.join(APP_ROOT, 'api/containers/[id]/logs/route.ts'), 'utf-8');
    const stream = fs.readFileSync(
      path.join(APP_ROOT, 'api/containers/[id]/logs/stream/route.ts'), 'utf-8');
    expect(/cookieScope\s*:/.test(source)).toBe(false);
    expect(/cookieScope\s*:/.test(stream)).toBe(false);
  });
});
