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

/** The tokenScope on the first handler declared in a single-handler route. */
function soleScope(relPath: string): string | null {
  const m = src(relPath).match(/tokenScope:\s*'([a-z]+)'/);
  return m ? m[1] : null;
}

describe('updates signal is read-scoped for Bearer tokens (#2243)', () => {
  it('image-updates GET → read', () => {
    expect(soleScope('system/stacks/image-updates/route.ts')).toBe('read');
  });
  it('templates/upgrades-pending GET → read', () => {
    expect(soleScope('system/templates/upgrades-pending/route.ts')).toBe('read');
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
    expect(soleScope('approvals/[id]/route.ts')).toBe('read');
  });

  it('POST /api/approvals/[id]/approve → mutate (verdict, not destroy)', () => {
    expect(soleScope('approvals/[id]/approve/route.ts')).toBe('mutate');
  });

  it('POST /api/approvals/[id]/reject → mutate', () => {
    expect(soleScope('approvals/[id]/reject/route.ts')).toBe('mutate');
  });

  it('approve + reject enforce the token self-approval guard (isSelfApproval)', () => {
    // The human-in-the-loop invariant: a token cannot resolve the request it
    // proposed. Pinned so a refactor can't silently drop the guard while the
    // route stays token-reachable.
    expect(src('approvals/[id]/approve/route.ts')).toMatch(/isSelfApproval/);
    expect(src('approvals/[id]/reject/route.ts')).toMatch(/isSelfApproval/);
  });
});
