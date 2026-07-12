/**
 * MCP pending-approval HTTP intercept (#1766, #2234) — the LIVE production handler.
 *
 * This is intercepted in server.ts BEFORE Next.js `handle()` rather than served
 * by the Next.js API route (`app/api/system/mcp/approve/**`). Historically the
 * intercept existed because the destructive-tool approvals were kept in an
 * in-memory store that Turbopack bundled twice; #2234 moved them to the durable
 * `lib/approvals` queue (a JSON file under DATA_DIR), so the store is now shared
 * regardless — but the intercept is retained as the cookie-only surface these
 * MCP-specific views (Home `PendingApprovalsCard`, Settings → MCP) already drive.
 *
 * As of #2234 this handler is a thin, cookie-gated adapter over `lib/approvals`:
 * it exposes the MCP-kind approvals (those carrying an `on_approve.mcp` action)
 * in the legacy `{ pendingId, toolName, args, caller, expiresAt }` shape and
 * approves/rejects them by id. The operator's generic Approvals UI reads the
 * SAME records over `/api/approvals` — one durable store, three surfaces.
 *
 * SECURITY (the whole point of the gate):
 *   - Authentication is COOKIE-SESSION ONLY. A `Bearer sb_…` token (the
 *     proposing agent) carries no session cookie, so `resolveSession` returns
 *     null → 401, and neither approve nor reject is ever reached. The agent has
 *     no path to self-approve its own destructive proposal.
 *   - CSRF: the `session` cookie is `SameSite=Lax` + `httpOnly` (see
 *     packages/backend/src/lib/auth.ts `login`). A cross-site POST from a
 *     malicious origin does NOT carry the cookie under Lax, so a forged confirm
 *     can't ride the user's session. No protection is dropped by the intercept.
 */
import {
  listApprovals,
  getApproval,
  approveApproval,
  rejectApproval,
  type ApprovalRequest,
} from '@/lib/approvals';

const BASE = '/api/system/mcp/approve';
const PREFIX = `${BASE}/`;

export interface ApproveResponse {
  status: number;
  body: unknown;
}

/**
 * Legacy MCP pending-approval view. Kept stable for the existing UI consumers
 * (Home `PendingApprovalsCard`, Settings → MCP). `pendingId` is the durable
 * approval id; `expiresAt` is `null` now that approvals are durable (they no
 * longer expire) — the UI renders a stable label rather than a countdown.
 */
export interface McpApprovalView {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  expiresAt: number | null;
}

/** True for a persisted approval that re-dispatches an MCP tool on approve. */
function isMcpApproval(r: ApprovalRequest): boolean {
  return Boolean(r.on_approve?.mcp);
}

function toMcpView(r: ApprovalRequest): McpApprovalView {
  const mcp = r.on_approve.mcp!;
  const caller = typeof r.payload?.caller === 'string' ? (r.payload.caller as string) : undefined;
  return { pendingId: r.id, toolName: mcp.toolName, args: mcp.args, caller, expiresAt: null };
}

/** List the pending MCP-kind approvals (durable, cookie-gated). */
async function listPendingMcpApprovals(): Promise<McpApprovalView[]> {
  const all = await listApprovals();
  return all.filter(r => r.status === 'pending' && isMcpApproval(r)).map(toMcpView);
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
 *
 *   GET    /api/system/mcp/approve      → list pending MCP approvals
 *   POST   /api/system/mcp/approve/:id  → approve (re-dispatch the tool)
 *   DELETE /api/system/mcp/approve/:id  → reject (cancel the proposal)
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
    const pending = await listPendingMcpApprovals();
    return { status: 200, body: { pending } };
  }

  const isItemPath = input.pathname !== BASE && input.pathname.startsWith(PREFIX);
  if (isItemPath && (input.method === 'POST' || input.method === 'DELETE')) {
    const id = decodeURIComponent(input.pathname.slice(PREFIX.length));
    try {
      // Only act on MCP-kind approvals through this surface — a move/restart
      // approval belongs to the generic /api/approvals route.
      const existing = await getApproval(id);
      if (!existing || !isMcpApproval(existing)) {
        return { status: 410, body: gone() };
      }
      const result =
        input.method === 'DELETE'
          ? await rejectApproval(id)
          : await approveApproval(id);
      return { status: 200, body: { ok: true, result } };
    } catch (e) {
      // A tool-dispatch failure or an already-resolved request. Surface the
      // message so the operator learns the tool did not run, rather than a
      // silent success.
      const message = e instanceof Error ? e.message : String(e);
      if (/already (approved|rejected)|not found/i.test(message)) {
        return { status: 410, body: gone() };
      }
      input.onError?.(e);
      return { status: 500, body: { ok: false, error: message } };
    }
  }

  return { status: 405, body: { error: 'Method not allowed' } };
}

function gone(): { ok: false; error: string } {
  return {
    ok: false,
    error:
      'This approval has expired or was already used. Ask the agent to propose the action again.',
  };
}
