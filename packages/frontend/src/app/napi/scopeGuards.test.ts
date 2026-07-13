import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Token-scope lock-in for the read-only `/napi/*` companion-app surface
 * (#2252). Each of home/approvals/services/upgrades is opened to a `read`-scoped
 * SB-MCP Bearer token so the Solaris-android app can poll them without a cookie.
 * The gate machinery (accept right-scope Bearer, 401 wrong/absent scope with NO
 * cookie fall-through) is proven in `requireSession.test.ts`; this test pins the
 * EXACT scope baked into each route's `withApiHandler(...)` OPTIONS.
 *
 * Anti-false-green (the #2249 lesson): we deliberately read `tokenScope` out of
 * the FIRST argument to `withApiHandler` (the options object handler.ts's gate
 * actually reads) — NOT a bare `tokenScope:'read'` anywhere in the file, which
 * would also match a scope written into a CODE COMMENT or an INNER
 * `requireSession(req, {…})` call the wrapper gate never sees. That inner-call
 * shape 401s a valid Bearer (box-verify #2243 RED, CI false-green). We assert
 * the scope IS in the options AND is NOT hidden on an inner requireSession.
 */
const NAPI_DIR = __dirname;

function src(relPath: string): string {
  return readFileSync(path.join(NAPI_DIR, relPath), 'utf8');
}

/** The tokenScope inside the options object that is the FIRST arg to
 *  withApiHandler — the only place handler.ts's built-in gate reads it. */
function optionsScope(relPath: string): string | null {
  const s = src(relPath);
  const m = s.match(/withApiHandler(?:Params)?\s*(?:<[^>]*>)?\s*\(\s*(\{[^}]*\})/);
  if (!m) return null;
  const scope = m[1].match(/tokenScope:\s*'([a-z]+)'/);
  return scope ? scope[1] : null;
}

/** True if the scope is (wrongly) hidden on an inner requireSession call — the
 *  shape that 401s a valid Bearer because the wrapper gate ran scopeless. */
function hasInnerRequireSessionScope(relPath: string): boolean {
  return /requireSession\([^)]*tokenScope/.test(src(relPath));
}

const ROUTES = ['home/route.ts', 'approvals/route.ts', 'services/route.ts', 'upgrades/route.ts'];

describe('/napi/* read endpoints are read-scoped in the handler OPTIONS (#2252, #2249)', () => {
  for (const route of ROUTES) {
    it(`${route} → tokenScope 'read' in withApiHandler options, not an inner call`, () => {
      expect(optionsScope(route)).toBe('read');
      // #2249: must NOT live on an inner requireSession — that 401s a valid
      // Bearer because handler.ts's own gate ran scopeless first.
      expect(hasInnerRequireSessionScope(route)).toBe(false);
    });
  }
});
