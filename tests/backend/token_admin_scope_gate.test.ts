/**
 * Class-level enforcement (#2944): EVERY verb on the token-administration
 * surface declares a scope hold.
 *
 * #2919 held one verb (`POST` = mint) of one pair of routes and shipped. The
 * sibling verbs in the very same files — `DELETE` (revoke one) and the bulk
 * `POST /api/system/api-tokens/revoke` — stayed open, so a `read`-only token
 * traded for a cookie at `POST /api/auth/session-from-token` could still delete
 * every credential on the box. That is why this gate is **per verb**, not per
 * file: `credential_mint_scope_gate.test.ts` (#2919) asks "does this route file
 * declare a scope anywhere", which a file whose POST is gated answers `yes`
 * while its DELETE hangs open.
 *
 * The surface is defined by what a route *does*, not by what it declares:
 * anything whose route file — or a shared `@/lib/api/*` handler it imports —
 * reaches a token-administration primitive (mint, revoke, list, sweep, or the
 * bootstrap bridge's revoke/re-activate). It deliberately is NOT "routes that
 * declare a `tokenScope`": the proxy applies no scope check to a session cookie,
 * and `/api/auth/session-from-token` mints a cookie whose principal is still a
 * token, so a route that never accepts a `Bearer` is still reachable by a
 * token principal.
 *
 * To pass, a verb must declare `cookieScope` (or `tokenScope`) in its
 * `withApiHandler` options. Anything else needs an EXEMPT entry stating why it
 * is safe — a new entry is a security decision, not bookkeeping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_SRC = path.join(REPO_ROOT, 'packages', 'frontend', 'src');
const API_ROOT = path.join(FRONTEND_SRC, 'app', 'api');
const BACKEND_API_LIB = path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib', 'api');

/**
 * Administering a credential: handing one out, taking one back, enumerating the
 * store, or re-opening the reconnect bridge. `verifyToken`/`tokenIsLive` are
 * deliberately absent — verifying a presented credential is every gated route's
 * job and would swallow the whole API surface.
 */
const TOKEN_ADMIN_CALL =
  /\b(?:createToken|createDelegatedToken|revokeToken|revokeTokens|revokeDelegatedToken|listTokens|sweepExpiredTokens|revokeBootstrapToken|reactivateBootstrapToken)\s*\(/;

const DECLARES_SCOPE = /\b(?:tokenScope|cookieScope)\s*:/;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Verbs that administer a credential under a *different*, documented gate.
 * Keyed `<api path>#<VERB>`.
 */
const EXEMPT: Record<string, string> = {
  '/api/system/api-tokens/delegate#POST':
    'Delegated child-mint (#2048). `skipAuth` because the parent Bearer token IS the '
    + 'credential — there is no fixed scope to hold, the parent may carry any — and '
    + '`createDelegatedToken` enforces child ⊆ parent and TTL ≤ parent inside the handler.',
  '/api/system/api-tokens/delegate#DELETE':
    'Delegated child-revoke (#2680). Same credential model as the mint above; the authority '
    + 'is narrower than any scope could express — a parent may revoke ITS OWN children and '
    + 'nothing else, enforced in `revokeDelegatedToken`. This is the door the claude-dev '
    + 'config UI uses; it holds one token and has no session at all.',
  '/api/auth/token-from-authelia-session#POST':
    'Authelia forward-auth mint (#2246/#2249). Identity comes only from proxy-injected '
    + 'Remote-User/Remote-Groups, it REFUSES any caller presenting a Bearer (so no token '
    + 'principal reaches it at all), and the minted scopes are a fixed constant excluding '
    + 'destroy/exec/reboot. Same exemption as `credential_mint_scope_gate.test.ts` (#2919).',
  '/api/system/mcp-bootstrap#GET':
    'Status only: `{ active, expiresAt, minutesRemaining }`, never the hash. The onboarding '
    + 'wizard reads it before any session exists, so there is no principal to hold — and '
    + 'nothing enumerable to hold back.',
};

/** The scope tier each gated verb must carry. Pins the tier so a later edit
 *  cannot quietly downgrade a revoke to `read`. */
const REQUIRED_SCOPE: Record<string, string> = {
  '/api/system/api-tokens#GET': 'read',
  '/api/system/api-tokens#POST': 'mutate',
  '/api/system/api-tokens#DELETE': 'destroy',
  '/api/system/mcp-tokens#GET': 'read',
  '/api/system/mcp-tokens#POST': 'mutate',
  '/api/system/mcp-tokens#DELETE': 'destroy',
  '/api/system/api-tokens/revoke#POST': 'destroy',
  '/api/system/mcp-bootstrap#POST': 'mutate',
  '/api/system/mcp-bootstrap#DELETE': 'destroy',
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

/**
 * The `withApiHandler` options object for one exported verb, as source text.
 *
 * Brace-matched rather than regexed: the generic parameters carry
 * `z.infer<typeof X>`, whose nested `>` defeats a `<[^>]*>` match, and that
 * silently skipping a verb is exactly the failure this test exists to prevent.
 * Returns null when the verb is not exported at all.
 */
function verbOptions(src: string, verb: string): string | null {
  const decl = new RegExp(`export\\s+const\\s+${verb}\\s*=`).exec(src);
  if (!decl) return null;
  const wrapper = src.indexOf('withApiHandler', decl.index);
  if (wrapper === -1) return null;
  const open = src.indexOf('{', wrapper);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

interface Verb { key: string; options: string }

/** Every exported verb of every route on the token-administration surface. */
function tokenAdminVerbs(): Verb[] {
  const out: Verb[] = [];
  for (const file of walkRoutes(API_ROOT)) {
    if (!TOKEN_ADMIN_CALL.test(handlerSources(file))) continue;
    const src = fs.readFileSync(file, 'utf-8');
    const apiPath = fileToApiPath(file);
    for (const verb of VERBS) {
      const options = verbOptions(src, verb);
      if (options !== null) out.push({ key: `${apiPath}#${verb}`, options });
    }
  }
  return out;
}

describe('the token-administration surface is scope-held, verb by verb (#2944)', () => {
  it('every verb declares a scope or is exempt with a stated reason', () => {
    const verbs = tokenAdminVerbs();
    const offenders = verbs
      .filter(v => !(v.key in EXEMPT) && !DECLARES_SCOPE.test(v.options))
      .map(v => v.key);

    // The walk must actually be finding the surface — a moved directory or a
    // broken regex would otherwise report a clean, meaningless zero.
    const found = verbs.map(v => v.key);
    for (const key of Object.keys(REQUIRED_SCOPE)) expect(found).toContain(key);
    expect(found.length).toBeGreaterThanOrEqual(12);

    expect(
      offenders,
      `${offenders.length} token-administration verb(s) can be reached without a scope hold. `
      + `A cookie is not a scope: /api/auth/session-from-token mints one whose principal is `
      + `still a token, so a read-only principal reaches any ungated verb here. Declare `
      + `\`cookieScope\` in the withApiHandler options (see #2919/#2944), or add an EXEMPT `
      + `entry saying why this one is safe.\n\nOffenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('each gated verb carries the tier its blast radius warrants', () => {
    const byKey = new Map(tokenAdminVerbs().map(v => [v.key, v.options]));
    for (const [key, scope] of Object.entries(REQUIRED_SCOPE)) {
      const options = byKey.get(key);
      expect(options, `${key} is no longer exported`).toBeDefined();
      expect(
        options,
        `${key} must be held to '${scope}' — revoking a credential is irreversible and `
        + `minting one is privileged; scopes are NOT nested (docs/SCOPE_AUDIT.md), so a `
        + `weaker tier here is a real widening.`,
      ).toMatch(new RegExp(`cookieScope\\s*:\\s*'${scope}'`));
    }
  });

  it('no token-administration verb opens the Bearer branch', () => {
    // `tokenScope` would hold a bridged cookie AND make the route reachable with a
    // raw `Authorization: Bearer sb_…`. On a credential-administration route the
    // second half is its own hole (#2919): a short-lived token could then revoke or
    // mint directly, escaping the delegation chain's TTL narrowing and cascading
    // revocation. The two delegate verbs are the deliberate exception — their
    // credential IS the parent Bearer, and their authority is "own children only".
    const offenders = tokenAdminVerbs()
      .filter(v => /\btokenScope\s*:/.test(v.options))
      .map(v => v.key);
    expect(offenders).toEqual([]);
  });
});
