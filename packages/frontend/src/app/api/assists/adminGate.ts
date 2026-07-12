import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { scopeSatisfiedBy } from '@/lib/auth/apiScope';

/**
 * Admin gate for the assists-editor mutating routes (approve/reject/revert,
 * #2221). These routes carry `tokenScope: 'read'`, so `requireSession` has
 * already 401'd an unauthenticated caller but ADMITS any authenticated
 * principal: a session cookie (a logged-in admin, all scopes) or any valid
 * `Bearer sb_…` token (which holds at least `read`).
 *
 * This second check is the AUTHORIZATION step: it turns an authenticated-but-
 * under-scoped principal into a 403 (Forbidden) rather than 401
 * (Unauthenticated). A scoped API token whose scopes do NOT satisfy `mutate` is
 * a non-admin caller and must be refused with 403, per the acceptance criteria.
 * A cookie/internal session carries all scopes (its `scopes` field is omitted,
 * meaning "all") and always passes.
 *
 * Returns a 403 NextResponse to short-circuit, or null to proceed.
 */
export function requireAssistAdmin(auth: SessionPayload | undefined): NextResponse | null {
  if (!auth) {
    // Should not happen on a mutate-gated route, but fail closed.
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Omitted scopes == all scopes (cookie / internal session). A scoped token
  // must actually hold (or imply) `mutate`.
  if (auth.scopes && !scopeSatisfiedBy(auth.scopes, 'mutate')) {
    return NextResponse.json({ error: 'Forbidden: admin (mutate) scope required' }, { status: 403 });
  }
  return null;
}
