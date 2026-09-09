/**
 * Class-level enforcement (#2919): every /api/* route that MINTS or ELEVATES a
 * credential must gate on the caller's own authority.
 *
 * A single-endpoint test would not have closed #2919. The defect was structural:
 * `cookieScopeRefusal` (#2768) is a no-op on a route that declares no scope, so
 * a mint route wrapped as `withApiHandler({}, …)` looked guarded and was not —
 * and the same shape can reappear the next time someone adds a credential-
 * issuing endpoint. This walks the route surface instead, in the spirit of
 * `route_session_gate.test.ts` (#596), and fails on the *class* of miss.
 *
 * A credential-minting route is one whose handler calls `createToken`,
 * `createDelegatedToken` or `encryptSession` — the three ways this codebase
 * hands out authority (an API token, a delegated child token, a session
 * cookie). Handlers that live in `packages/backend/src/lib/api/*` are followed
 * through the route file's imports, because that is exactly where #2919 hid:
 * the route file was two lines long and the hole was in the shared handler.
 *
 * To be gated, such a route must do at least one of:
 *   - declare `tokenScope` / `cookieScope` in its `withApiHandler` options
 *     (`requireSession` then holds a scoped session to it), or
 *   - perform an explicit subset check (`scopesAreSubset` / `scopeSatisfiedBy`)
 *     against the caller's own scopes.
 *
 * Anything else needs an entry in EXEMPT below, with the reason it is safe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_SRC = path.join(REPO_ROOT, 'packages', 'frontend', 'src');
const API_ROOT = path.join(FRONTEND_SRC, 'app', 'api');
const BACKEND_API_LIB = path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib', 'api');

/** Calls that hand out a credential: an API token, a delegated child, a session. */
const MINTS_CREDENTIAL = /\b(?:createToken|createDelegatedToken|encryptSession)\s*\(/;

/** The wrapper-level gate: a declared scope makes `cookieScopeRefusal` live. */
const DECLARES_SCOPE = /\b(?:tokenScope|cookieScope)\s*:/;

/** The handler-level gate: the caller's own scopes bound what it may mint. */
const CHECKS_SUBSET = /\b(?:scopesAreSubset|scopeSatisfiedBy)\s*\(/;

/**
 * Routes that mint a credential under a *different*, documented gate. Each
 * entry states why it is safe — a new entry is a security decision, not
 * bookkeeping.
 */
const EXEMPT: Record<string, string> = {
  '/api/auth/session-from-token':
    'The token→session bridge (#2047). It copies `scopes: token.scopes` verbatim, so it '
    + 'cannot widen; the "no literal scope list" assertion below is what pins that.',
  '/api/auth/token-from-authelia-session':
    'Authelia forward-auth mint (#2246/#2249). Identity comes only from proxy-injected '
    + 'Remote-User/Remote-Groups, it REFUSES any caller presenting a Bearer, and the minted '
    + 'scopes are a fixed constant that excludes destroy/exec/reboot.',
};

function* walkRoutes(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkRoutes(full);
    else if (entry.isFile() && entry.name === 'route.ts') yield full;
  }
}

function fileToApiPath(file: string): string {
  return '/' + path.relative(path.join(FRONTEND_SRC, 'app'), file).replace(/\/route\.ts$/, '');
}

/** Route source + the sources of the shared `@/lib/api/*` handlers it imports. */
function handlerSources(routeFile: string): string {
  const src = fs.readFileSync(routeFile, 'utf-8');
  const parts = [src];
  for (const m of src.matchAll(/from\s+'@\/lib\/api\/([A-Za-z0-9_/-]+)'/g)) {
    const mod = path.join(BACKEND_API_LIB, `${m[1]}.ts`);
    if (fs.existsSync(mod)) parts.push(fs.readFileSync(mod, 'utf-8'));
  }
  return parts.join('\n');
}

describe('credential-minting routes are scope-gated (#2919)', () => {
  it('every route that mints or elevates a credential declares a scope or checks the subset', () => {
    const offenders: string[] = [];
    const covered: string[] = [];

    for (const file of walkRoutes(API_ROOT)) {
      const apiPath = fileToApiPath(file);
      const routeSrc = fs.readFileSync(file, 'utf-8');
      const combined = handlerSources(file);
      if (!MINTS_CREDENTIAL.test(combined)) continue;
      if (apiPath in EXEMPT) { covered.push(apiPath); continue; }
      if (DECLARES_SCOPE.test(routeSrc) || CHECKS_SUBSET.test(combined)) {
        covered.push(apiPath);
        continue;
      }
      offenders.push(`${path.relative(REPO_ROOT, file)} (${apiPath})`);
    }

    // The walk must actually be finding mint routes — a broken regex or a moved
    // directory would otherwise report a clean, meaningless zero (the "check the
    // denominator" rule).
    expect(covered.length).toBeGreaterThanOrEqual(4);
    expect(covered).toContain('/api/system/api-tokens');
    expect(covered).toContain('/api/system/mcp-tokens');

    expect(
      offenders,
      `${offenders.length} credential-minting route(s) hand out authority without gating on the `
      + `caller's own. Declare \`cookieScope\` (or \`tokenScope\`) in the withApiHandler options, or `
      + `compare the requested scopes against \`auth.scopes\` with \`scopeSatisfiedBy\` from `
      + `apiScope.ts. See #2919.\n\nOffenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the token→session bridge copies the token scopes and never a list of its own', () => {
    // The bridge is exempt above *because* it cannot widen. If it ever grew a
    // literal scope array, that exemption would be silently wrong — so pin it.
    const src = fs.readFileSync(
      path.join(API_ROOT, 'auth', 'session-from-token', 'route.ts'), 'utf-8',
    );
    expect(src).toMatch(/scopes:\s*token\.scopes/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/scopes\s*:\s*\[/);
  });

  it('cookieScopeRefusal cannot go inert again: both mint routes declare a scope', () => {
    for (const rel of ['system/api-tokens', 'system/mcp-tokens']) {
      const src = fs.readFileSync(path.join(API_ROOT, rel, 'route.ts'), 'utf-8');
      const post = src.match(/export const POST = withApiHandler\(([^)]*)\)/);
      expect(post, `${rel}/route.ts has no recognisable POST export`).not.toBeNull();
      expect(post![1], `${rel} POST must declare a scope`).toMatch(DECLARES_SCOPE);
    }
  });
});
