/**
 * MCP pending-approval HTTP intercept (#1766 fix) — the LIVE production handler.
 *
 * This is intercepted in server.ts BEFORE Next.js `handle()` rather than served
 * by the Next.js API route (`app/api/system/mcp/approve/**`). Next.js Turbopack
 * bundles a SEPARATE copy of the in-memory `pendingApprovals` store for each
 * compilation unit, so a destructive call *proposed* via the `/mcp` endpoint
 * lands in a different Map than the one a Next.js route would read — every
 * confirm 410'd. Serving the approve routes from the same module graph as the
 * `/mcp` handler (server.ts) makes propose + confirm share one store.
 *
 * Extracted into this module so the security property is unit-testable: the
 * server.ts request closure isn't, but `handleMcpApproveRequest` is a pure-ish
 * function over the request primitives.
 *
 * SECURITY (the whole point of the gate):
 *   - Authentication is COOKIE-SESSION ONLY. A `Bearer sb_…` token (the
 *     proposing agent) carries no session cookie, so `resolveSession` returns
 *     null → 401, and `approvePendingApproval` is NEVER called. The agent has
 *     no path to self-approve its own destructive proposal.
 *   - CSRF: the `session` cookie is `SameSite=Lax` + `httpOnly` (see
 *     packages/backend/src/lib/auth.ts `login`). A cross-site POST from a
 *     malicious origin does NOT carry the cookie under Lax (Lax only attaches
 *     on top-level GET navigations), so a forged confirm can't ride the user's
 *     session. This matches the protection the superseded Next.js route relied
 *     on — `requireSession`/`withApiHandler` carried no CSRF token either; both
 *     paths rest on SameSite=Lax. No protection is dropped by the intercept.
 */
import {
  listPendingApprovals,
  approvePendingApproval,
  ApprovalExpiredError,
  type PendingApprovalView,
} from './pendingApprovals';

const BASE = '/api/system/mcp/approve';
const PREFIX = `${BASE}/`;

export interface ApproveResponse {
  status: number;
  body: unknown;
}

/** True for any path this intercept owns (so server.ts can route to it). */
export function isMcpApprovePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === BASE || (pathname.startsWith(PREFIX) && pathname.length > PREFIX.length);
}

/**
 * Handle a `/api/system/mcp/approve[/:id]` request. `resolveSession` resolves
 * the caller's session from the cookie header (null for Bearer/anon → 401).
 * Returns the status + JSON body for server.ts to write.
 */
export async function handleMcpApproveRequest(input: {
  method: string | undefined;
  pathname: string;
  resolveSession: () => Promise<unknown>;
  onError?: (e: unknown) => void;
}): Promise<ApproveResponse> {
  const session = await input.resolveSession();
  if (!session) {
    // Bearer token or anonymous — 401; the agent must not self-approve.
    return { status: 401, body: { error: 'Authentication required' } };
  }

  if (input.method === 'GET' && input.pathname === BASE) {
    const pending: PendingApprovalView[] = listPendingApprovals();
    return { status: 200, body: { pending } };
  }

  if (input.method === 'POST' && input.pathname !== BASE) {
    const pendingId = input.pathname.slice(PREFIX.length);
    try {
      const result = await approvePendingApproval(pendingId);
      return { status: 200, body: { ok: true, result } };
    } catch (e) {
      if (e instanceof ApprovalExpiredError) {
        return {
          status: 410,
          body: {
            ok: false,
            error:
              'This approval has expired or was already used. Ask the agent to propose the action again.',
          },
        };
      }
      input.onError?.(e);
      return { status: 500, body: { ok: false, error: 'internal server error' } };
    }
  }

  return { status: 405, body: { error: 'Method not allowed' } };
}
