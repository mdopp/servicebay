import { randomUUID } from 'crypto';

/**
 * Native per-tool approval gate for destructive MCP tools (#1766).
 *
 * Token-authenticated MCP callers (the "agent") can *propose* a destructive
 * tool call but cannot *execute* it: the call is parked here as a pending
 * approval and the agent gets back a handle instead of a result. A human,
 * authenticated with a session **cookie** (never a Bearer token — see the
 * confirm route), then approves the specific pending call and it runs. The
 * proposing token holder has no path to self-approve.
 *
 * The store is intentionally in-memory and single-process:
 *   - approvals are short-lived (TTL ~5 min) and don't survive a restart by
 *     design — a stale, abandoned destructive proposal should evaporate, not
 *     linger on disk to be approved hours later.
 *   - single-use: claiming an approval removes it, so a confirmed call can't
 *     be replayed.
 *
 * `execute` is the deferred tail of `safeHandler` (snapshot → real handler →
 * audit/notify side-effects), captured as a thunk at propose time so the
 * approved call runs through exactly the same safety path it would have run
 * inline, just gated on the human confirm.
 */

/** Default time a pending approval stays claimable before it expires. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export interface PendingApproval {
  pendingId: string;
  toolName: string;
  /** The arguments the tool was invoked with (for the human to review). */
  args: Record<string, unknown>;
  /** Who proposed it — e.g. `token:ci-bot`. */
  caller?: string;
  /** Epoch ms at which the approval expires and can no longer be claimed. */
  expiresAt: number;
  /**
   * The deferred call. Runs the snapshot + real handler + audit/notify tail
   * exactly as the inline path would have. Resolves to the tool result.
   */
  execute: () => Promise<unknown>;
}

/** Public view of a pending approval — never exposes the `execute` thunk. */
export interface PendingApprovalView {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  expiresAt: number;
}

const store = new Map<string, PendingApproval>();

function isExpired(entry: PendingApproval, now: number): boolean {
  return entry.expiresAt <= now;
}

/** Drop every expired entry. Called opportunistically on each access. */
function sweep(now: number = Date.now()): void {
  for (const [id, entry] of store) {
    if (isExpired(entry, now)) store.delete(id);
  }
}

function toView(entry: PendingApproval): PendingApprovalView {
  return {
    pendingId: entry.pendingId,
    toolName: entry.toolName,
    args: entry.args,
    caller: entry.caller,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Register a destructive tool call as pending human approval. Returns the
 * handle the proposing (token) caller gets back in place of a tool result.
 */
export function createPendingApproval(input: {
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  execute: () => Promise<unknown>;
  ttlMs?: number;
}): PendingApprovalView {
  sweep();
  const pendingId = randomUUID();
  const entry: PendingApproval = {
    pendingId,
    toolName: input.toolName,
    args: input.args,
    caller: input.caller,
    expiresAt: Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS),
    execute: input.execute,
  };
  store.set(pendingId, entry);
  return toView(entry);
}

/** List the currently-claimable pending approvals (expired ones swept out). */
export function listPendingApprovals(): PendingApprovalView[] {
  sweep();
  return [...store.values()].map(toView);
}

/** Look up a single pending approval without claiming it. */
export function getPendingApproval(pendingId: string): PendingApprovalView | undefined {
  sweep();
  const entry = store.get(pendingId);
  return entry ? toView(entry) : undefined;
}

export class ApprovalExpiredError extends Error {
  constructor(public readonly pendingId: string) {
    super(`Approval ${pendingId} has expired or does not exist`);
    this.name = 'ApprovalExpiredError';
  }
}

/**
 * Approve and run a pending call. Single-use: the entry is removed before the
 * deferred handler runs, so it can't be confirmed twice or replayed even if
 * the underlying call is slow. Throws {@link ApprovalExpiredError} when the id
 * is unknown or expired.
 */
export async function approvePendingApproval(pendingId: string): Promise<unknown> {
  sweep();
  const entry = store.get(pendingId);
  if (!entry || isExpired(entry, Date.now())) {
    store.delete(pendingId);
    throw new ApprovalExpiredError(pendingId);
  }
  // Claim (single-use) BEFORE executing so a concurrent confirm can't double-run.
  store.delete(pendingId);
  return entry.execute();
}

/** Test-only: clear all pending approvals. */
export function __clearPendingApprovalsForTest(): void {
  store.clear();
}
