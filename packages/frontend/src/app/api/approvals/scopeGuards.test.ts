import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Token-scope lock-in for the updates + approvals REST surface (#2243, #2244).
 *
 * These routes were opened to a scoped SB-MCP Bearer token so an external
 * consumer (Solaris Wartung chat) can poll pending updates + the approval feed
 * and deliver the operator's verdict. Each route declares its guard inline via
 * `withApiHandler({ tokenScope })` / `requireSession(req, { tokenScope })`; the
 * gate machinery itself (accept right-scope Bearer, 401 wrong/absent scope with
 * NO cookie fall-through, cookie session unchanged) is already proven in
 * `packages/backend/src/lib/api/requireSession.test.ts`. This test pins the
 * exact scope baked into each route so a regression — widening a read route to
 * mutate, or dropping the deny-by-default on the submit POST — fails CI.
 *
 * Source-level (not a request round-trip): the guard IS the literal scope
 * string in the route source, and these routes pull heavy install/registry
 * deps a unit test should not load to read one token.
 */
const API_DIR = path.resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(path.join(API_DIR, relPath), 'utf8');
}

/**
 * The tokenScope baked into the route's `withApiHandler(...)` / `withApiHandlerParams(...)`
 * OPTIONS object — the ONLY place the built-in gate reads it (#2249).
 *
 * We deliberately do NOT match a bare `tokenScope:'read'` anywhere in the file:
 * the old regex matched the scope written in a CODE COMMENT, so the test passed
 * even when the routes wired the scope into an INNER `requireSession(req, {…})`
 * call that the wrapper gate never saw → a valid read Bearer 401'd (box-verify
 * #2243 RED, CI false-green). This scopes the match to the handler options.
 */
function optionsScope(relPath: string): string | null {
  const s = src(relPath);
  // Grab the options object literal that is the FIRST argument to
  // withApiHandler / withApiHandlerParams, then read tokenScope out of it.
  const m = s.match(/withApiHandler(?:Params)?\s*(?:<[^>]*>)?\s*\(\s*(\{[^}]*\})/);
  if (!m) return null;
  const opts = m[1];
  const scope = opts.match(/tokenScope:\s*'([a-z]+)'/);
  return scope ? scope[1] : null;
}

/** Assert the route does NOT hide the scope in an inner requireSession call —
 *  that shape 401s a valid Bearer because the wrapper gate runs scopeless. */
function hasInnerRequireSessionScope(relPath: string): boolean {
  return /requireSession\([^)]*tokenScope/.test(src(relPath));
}

describe('updates signal is read-scoped for Bearer tokens (#2243, #2249)', () => {
  it('image-updates GET → read (in withApiHandler options, not a comment/inner call)', () => {
    expect(optionsScope('system/stacks/image-updates/route.ts')).toBe('read');
    // #2249: the scope must NOT live on an inner requireSession — that 401s a
    // valid Bearer because handler.ts's own gate ran scopeless first.
    expect(hasInnerRequireSessionScope('system/stacks/image-updates/route.ts')).toBe(false);
  });
  it('templates/upgrades-pending GET → read (in withApiHandler options)', () => {
    expect(optionsScope('system/templates/upgrades-pending/route.ts')).toBe('read');
    expect(hasInnerRequireSessionScope('system/templates/upgrades-pending/route.ts')).toBe(false);
  });
});

describe('approval feed is read-scoped, verdict is mutate-scoped (#2244)', () => {
  it('GET /api/approvals (list) → read', () => {
    // The list handler is the first (GET) block; the POST submit below must NOT
    // carry a tokenScope (stays cookie/internal-only) — asserted separately.
    const s = src('approvals/route.ts');
    const getBlock = s.slice(s.indexOf('export const GET'), s.indexOf('export const POST'));
    expect(getBlock).toMatch(/tokenScope:\s*'read'/);
  });

  it('POST /api/approvals (submit) stays cookie/internal-only — NO tokenScope (deny Bearer)', () => {
    // Opening submission to a token was explicitly out of scope for #2244; a
    // Bearer to this mutating verb must keep 401ing (no tokenScope opt-in).
    const s = src('approvals/route.ts');
    const postBlock = s.slice(s.indexOf('export const POST'));
    expect(postBlock).not.toMatch(/tokenScope/);
  });

  it('GET /api/approvals/[id] (detail) → read', () => {
    expect(optionsScope('approvals/[id]/route.ts')).toBe('read');
  });

  it('POST /api/approvals/[id]/approve → mutate (verdict, not destroy)', () => {
    expect(optionsScope('approvals/[id]/approve/route.ts')).toBe('mutate');
  });

  it('POST /api/approvals/[id]/reject → mutate', () => {
    expect(optionsScope('approvals/[id]/reject/route.ts')).toBe('mutate');
  });

  it('approve + reject enforce the token self-approval guard (isSelfApproval)', () => {
    // The human-in-the-loop invariant: a token cannot resolve the request it
    // proposed. Pinned so a refactor can't silently drop the guard while the
    // route stays token-reachable.
    expect(src('approvals/[id]/approve/route.ts')).toMatch(/isSelfApproval/);
    expect(src('approvals/[id]/reject/route.ts')).toMatch(/isSelfApproval/);
  });
});
