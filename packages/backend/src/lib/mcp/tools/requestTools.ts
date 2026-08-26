/**
 * Request-workflow MCP tools (#2384 extraction): the access/approval list
 * (#1818) and the scoped, admin-approved, self-expiring token request flow
 * (#2139 / #2245) that is built on the same pending→approve→poll pattern.
 *
 * THREE DISTINCT ID SPACES live behind this group, and each has exactly one
 * poll verb (#2653 — conflating them is what left a destroy-tier caller with
 * no way to learn whether its approved action ever ran):
 *   - `config.accessRequests`  → `file_access_request` id  → `get_access_request_status`
 *   - `auth/tokenRequests`     → `request_token` id        → `poll_token_request`
 *   - `lib/approvals`          → `approvalId`              → `get_approval_status`
 * The third is the operator-approval queue: every destroy-tier MCP tool parks
 * there (see `server.ts`'s approval gate) and so does a one-shot
 * `request_token`. An id from one space is never resolvable in another — the
 * tool descriptions below say so explicitly rather than inviting the call that
 * answers `not-found`.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getConfig, updateConfig, type AccessRequest } from '@/lib/config';
import { type ApiScope, ALL_SCOPES } from '@/lib/auth/apiScope';
import {
  submitTokenRequest,
  pollTokenRequest,
  listTokenRequests,
  MAX_TTL_SECS,
  ONE_SHOT_MAX_TTL_SECS,
  TokenRequestError,
  type TokenRequestStatus,
} from '@/lib/auth/tokenRequests';
import { getApproval, approvalOutcome } from '@/lib/approvals';
import { TOOL_SCOPES, APPROVAL_STATUS_TOOL } from '../toolPolicy';
import { textResult, errorResult, type ToolRegistration } from './context';

// Anti-spam cap mirrors the public POST route's MAX_PENDING (50).
const MAX_PENDING_ACCESS_REQUESTS = 50;

/**
 * Legacy entries written before #1824 carry the old `'resolved'` status, which
 * always meant the approve path — surface them as `'approved'` so callers only
 * ever see pending|approved|denied.
 */
const normalizeStatus = (s: AccessRequest['status']): 'pending' | 'approved' | 'denied' =>
  s === 'resolved' ? 'approved' : s;

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerRequestTools({ server, caller }: ToolRegistration) {
  // --- Access requests / approval workflow (#1818) ---
  // Programmatic surface over the same `config.accessRequests` list the
  // family portal feeds and the admin Settings page resolves. Lets an
  // agent (e.g. Solilos resident-onboarding, mdopp/solbay #355) file a
  // pending approval the admin acts on in the existing flow, then poll
  // its status to react on approval.
  server.tool(
    'file_access_request',
    'File a pending access/approval request to the admin\'s central access-request list (the same list the family portal feeds and Settings resolves). Returns the request id; poll it with get_access_request_status. Use for programmatic approvals (e.g. registering a new resident) — the admin approves or denies in the existing flow.',
    {
      subject: z.string().trim().min(1).max(120).describe('Human-readable label for who/what is being requested (e.g. the candidate resident\'s name).'),
      kind: z.string().trim().min(1).max(40).optional().describe('Category/provenance of the request (e.g. "resident"). Free-form; helps the admin triage.'),
      payload: z.string().trim().max(1000).optional().describe('Structured context for the admin (e.g. "voice profile enrolled").'),
      requested_by: z.string().trim().max(120).optional().describe('Who/what is filing the request — the calling agent or token identity, for the audit trail.'),
      email: z.email().max(200).optional().describe('Contact email for the subject, if known. Feeds the LLDAP user when the admin approves.'),
      username: z.string().trim().regex(/^[a-z0-9._-]{1,60}$/, 'Username must be lowercase letters, digits, ., _ or -, max 60 chars').optional().describe('Desired LLDAP login (uid). Supplying it lets the admin one-click Approve to auto-provision the user; omit to leave provisioning manual.'),
    },
    async ({ subject, kind, payload, requested_by, email, username }) => {
      const config = await getConfig();
      const existing = config.accessRequests ?? [];
      const pending = existing.filter(r => r.status === 'pending');
      if (pending.length >= MAX_PENDING_ACCESS_REQUESTS) {
        return errorResult(
          `Too many pending access requests (${pending.length}/${MAX_PENDING_ACCESS_REQUESTS}). The admin needs to resolve existing ones first.`,
        );
      }
      const newRequest: AccessRequest = {
        id: randomUUID(),
        requestedAt: new Date().toISOString(),
        name: subject,
        email: email ?? '',
        message: payload,
        status: 'pending',
        ...(kind ? { kind } : {}),
        ...(payload ? { payload } : {}),
        ...(requested_by ? { requestedBy: requested_by } : {}),
        ...(username ? { username } : {}),
      };
      await updateConfig({ accessRequests: [...existing, newRequest] });
      return textResult({ ok: true, id: newRequest.id, status: newRequest.status });
    },
  );

  // --- List Requests (#2324) — Tier-2 merge. One read-scoped tool with a
  // `type` discriminator over the two request lists that share the same call
  // shape + status enum, differing only in their backing store:
  //   type="access" → admin access/approval list (config.accessRequests)
  //   type="token"  → scoped-token request lifecycle (auth/tokenRequests)
  // Deliberately NOT merged with poll_token_request / get_access_request_status
  // (those poll one id; poll_token_request is non-idempotent) — see #2324. ---
  server.tool(
    'list_requests',
    `List pending/resolved requests via \`type\`: "access" (access requests on the admin's central list, filed by file_access_request) or "token" (scoped-token request lifecycle, request_token). Defaults to pending; pass status="approved", "denied", or "all". Token requests never return secrets — only metadata, granted scopes, expiry, and minted token id. Neither list contains the operator-approval queue that destroy-tier tools and one-shot request_token park in — poll an \`approvalId\` with ${APPROVAL_STATUS_TOOL}.`,
    {
      type: z.enum(['access', 'token']).describe('Which request list to read: access (file_access_request items) or token (scoped-token requests). Neither covers destroy-tier approvalIds.'),
      status: z.enum(['pending', 'approved', 'denied', 'all']).optional().default('pending').describe('Filter by status. Default: pending.'),
    },
    async ({ type, status }) => {
      if (type === 'token') {
        const requests = await listTokenRequests(status as TokenRequestStatus | 'all');
        return textResult({ requests });
      }
      const config = await getConfig();
      const all = config.accessRequests ?? [];
      const filtered = status === 'all' ? all : all.filter(r => normalizeStatus(r.status) === status);
      return textResult({
        requests: filtered.map(r => ({
          id: r.id,
          status: normalizeStatus(r.status),
          subject: r.name,
          kind: r.kind,
          payload: r.payload,
          requestedBy: r.requestedBy,
          email: r.email || undefined,
          requestedAt: r.requestedAt,
          resolvedAt: r.resolvedAt,
        })),
      });
    },
  );

  server.tool(
    'get_access_request_status',
    `Poll the status of one access request by id. Returns "pending" (awaiting an admin decision), "approved" (admin provisioned the user — proceed), "denied" (admin dismissed it — provision nothing and drop any captured data), or "not-found". This serves ONLY ids returned by file_access_request. An \`approvalId\` from a destroy-tier tool's pending_approval result or from a one-shot request_token belongs to a different store — poll those with ${APPROVAL_STATUS_TOOL} — and a token-request id with poll_token_request.`,
    {
      id: z.string().min(1).describe('Request id returned by file_access_request. Not an approvalId and not a token-request id.'),
    },
    async ({ id }) => {
      const config = await getConfig();
      const req = (config.accessRequests ?? []).find(r => r.id === id);
      if (!req) return textResult({ id, status: 'not-found' as const });
      return textResult({
        id: req.id,
        status: normalizeStatus(req.status),
        subject: req.name,
        kind: req.kind,
        requestedAt: req.requestedAt,
        resolvedAt: req.resolvedAt,
      });
    },
  );

  // --- Operator-approval status (#2653) ---
  // The read side of the destroy-tier approval gate. Every `destroy`-scoped
  // tool called by a token caller parks in `lib/approvals` and hands back an
  // `approvalId`; so does a one-shot `request_token`. Until this tool existed
  // that id resolved NOWHERE — `get_access_request_status` and `list_requests`
  // both read other stores — so a caller could only infer the outcome from the
  // observable end state, and could not see the outcome that matters most:
  // approved, then the action FAILED.
  //
  // Deliberately reports `approved-executed` and `approved-failed` as distinct
  // outcomes. Collapsing them into "approved" would rebuild exactly the blind
  // spot #2651 reported.
  server.tool(
    APPROVAL_STATUS_TOOL,
    'Poll one operator approval by the `approvalId` a destroy-tier tool\'s pending_approval result returns (delete_service, delete_health_check, remove_proxy_route, restore_backup, purge_trashed_service, set_boot_next_usb, factory_reset) or that a one-shot request_token returns. Outcomes: "pending" (no operator decision yet), "approved-executed" (approved AND the action ran), "approved-failed" (approved but the action threw — see `error`; it stays in the queue and can be retried), "rejected" (declined, nothing ran), "rejected-failed" (declined but the on-reject cleanup threw), or "not-found". This is a SEPARATE id space from file_access_request (use get_access_request_status) and from request_token (use poll_token_request).',
    {
      approval_id: z.string().min(1).describe('The `approvalId` from a pending_approval tool result or from a one-shot request_token.'),
    },
    async ({ approval_id }) => {
      const request = await getApproval(approval_id);
      if (!request) return textResult({ approvalId: approval_id, status: 'not-found' as const });
      // Report only non-secret metadata. The stored `payload` carries the
      // proposed tool's raw args, which are never echoed back here — the caller
      // supplied them and re-serving them is not this tool's job.
      const proposedTool = request.on_approve?.mcp?.toolName
        ?? (typeof request.payload?.toolName === 'string' ? request.payload.toolName : undefined);
      return textResult({
        approvalId: request.id,
        status: approvalOutcome(request),
        title: request.title,
        service: request.service,
        createdAt: request.created_at,
        ...(proposedTool ? { toolName: proposedTool } : {}),
        ...(request.on_approve?.mintToken
          ? { tokenRequestId: request.on_approve.mintToken.tokenRequestId, collectWith: 'poll_token_request' }
          : {}),
        ...(request.resolved_at ? { resolvedAt: request.resolved_at } : {}),
        ...(request.execution?.outcome === 'failed'
          ? { error: request.execution.error, failedAt: request.execution.at, stillPending: true }
          : {}),
      });
    },
  );

  // --- Scoped, admin-approved, self-expiring token request flow (#2139) ---
  // Built ON TOP of the pending→approve/adjust→poll pattern the access-request
  // tools use, but for TOKEN issuance (own store: auth/tokenRequests.ts). A
  // caller asks for least-privilege short-lived scopes + a reason; the admin
  // approves (optionally narrowing scopes / overriding TTL) or denies from the
  // dashboard; the caller polls to collect the minted `sb_` token once. The
  // token self-expires and is swept from api-tokens.json (auth/apiTokens.ts).
  const SCOPE_ENUM = z.enum(ALL_SCOPES as [ApiScope, ...ApiScope[]]);

  server.tool(
    'request_token',
    'Request a scoped, short-lived sb_ API token that a ServiceBay admin must approve. Names the scopes you need, a human reason, and a TTL in seconds. Returns a pending request id — NO token yet. Poll it with poll_token_request; the admin may approve with NARROWED scopes (least privilege) or a shorter TTL, or deny. This tool itself needs only the read scope: a request grants nothing until a human signs off. Pass one_shot_op to instead request a ONE-SHOT, owner-approved ELEVATED (destroy/exec) token bound to exactly one op on one service — it parks as an approval card, mints only after the owner approves, authorizes that op ONCE, then burns.',
    {
      scopes: z.array(SCOPE_ENUM).min(1).describe(`Scopes to request (least→most: ${ALL_SCOPES.join(', ')}). Ask for the minimum the task needs; the admin can only grant these or fewer. For a one-shot request pass exactly one elevated scope (destroy or exec) matching the tool's tier.`),
      reason: z.string().trim().min(1).max(1000).describe('Why the token is needed — the justification the admin weighs (e.g. "deploy one service, tor.dopp.cloud").'),
      ttl_seconds: z.number().int().positive().max(MAX_TTL_SECS).describe(`Requested time-to-live in seconds (max ${MAX_TTL_SECS} = 30d). The admin can shorten it. A one-shot request is clamped to ${ONE_SHOT_MAX_TTL_SECS}s. The token auto-expires and is deleted from storage.`),
      one_shot_op: z.object({
        tool_name: z.string().trim().min(1).describe('The single MCP tool this one-shot token may invoke (e.g. "delete_service" or "exec_command"). Must be a destroy/exec-tier tool.'),
        service: z.string().trim().optional().describe('Optional target service — when set, the token may only run the op against this service (e.g. delete_service on "media").'),
      }).optional().describe('Request a ONE-SHOT owner-approved ELEVATED token bound to this op instead of a standing grant. The request parks as an approval card; the ambient token gains nothing. On owner Approve, poll_token_request returns a single-use, short-TTL token authorizing exactly this op once.'),
    },
    async ({ scopes, reason, ttl_seconds, one_shot_op }) => {
      try {
        // For a one-shot request, validate the named tool is an elevated tier
        // and that the requested scope matches its tier — toolPolicy.ts owns
        // TOOL_SCOPES, so the tier resolution lives here (keeps tokenRequests
        // free of a cycle back to the tool map).
        if (one_shot_op) {
          const tier = TOOL_SCOPES[one_shot_op.tool_name];
          if (tier !== 'destroy' && tier !== 'exec') {
            return errorResult(`one_shot_op.tool_name "${one_shot_op.tool_name}" is not a destroy/exec-tier tool; a one-shot elevated token can only authorize an elevated op.`);
          }
          if (!(scopes.length === 1 && scopes[0] === tier)) {
            return errorResult(`For a one-shot request, scopes must be exactly ["${tier}"] to match ${one_shot_op.tool_name}; got [${scopes.join(',')}].`);
          }
        }
        const view = await submitTokenRequest({
          requestedScopes: scopes,
          requestedTtlSecs: ttl_seconds,
          reason,
          requestedBy: caller,
          ...(one_shot_op ? { oneShotOp: { toolName: one_shot_op.tool_name, ...(one_shot_op.service ? { service: one_shot_op.service } : {}) } } : {}),
        });
        return textResult({
          ok: true,
          id: view.id,
          status: view.status,
          ...(view.approvalId ? { approvalId: view.approvalId } : {}),
          message: one_shot_op
            ? `One-shot ${scopes[0]} token request filed as approval ${view.approvalId}. The owner must approve it (Settings → Access → Approvals); it cannot self-approve. Poll the APPROVAL's outcome with ${APPROVAL_STATUS_TOOL}(approval_id="${view.approvalId}") — pending, approved-executed, approved-failed or rejected — and collect the minted token with poll_token_request(id="${view.id}") once it reads approved-executed. The approvalId is not an access-request id; get_access_request_status does not serve it.`
            : `Token request filed. A ServiceBay admin must approve it (Settings → MCP). Poll with poll_token_request(id="${view.id}").`,
        });
      } catch (e) {
        return errorResult(e instanceof TokenRequestError ? e.message : e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'poll_token_request',
    'Poll a token request by id (from request_token). While "pending" no token is returned. On admin approval the FIRST poll returns the actual sb_ token secret plus the GRANTED (possibly narrowed) scopes and expiry — collect it then; later polls return no secret. "denied" → no token. The token auto-expires at the returned time and is then deleted from storage.',
    {
      id: z.string().min(1).describe('Request id returned by request_token.'),
    },
    async ({ id }) => {
      const result = await pollTokenRequest(id);
      return textResult(result);
    },
  );
}
