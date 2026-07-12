/**
 * Generic approval-request backend (#1843, epic #1842).
 *
 * Replaces the previous app-specific pending-gate. Any service can submit an
 * approval request that a ServiceBay admin reviews and then approves or
 * rejects from the dashboard. The request carries *declared* actions — a file
 * move and/or a service restart — so ServiceBay executes the side effect
 * without knowing anything about the requesting service's domain (it never
 * hard-codes a service name, path, or payload schema).
 *
 * Persistence is a single JSON file under DATA_DIR, atomic-written the same
 * way `ssoVerifyStore`/`jobStore` write theirs. A missing/corrupt file reads
 * back as an empty list so a fresh box reports no pending approvals.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';

const TAG = 'approvals';
const STORE_PATH = path.join(DATA_DIR, 'approvals.json');

/**
 * Canonical per-service data root on the *target node* (the box). A
 * service's declared move actions are confined to its own subtree under
 * this root — `/mnt/data/stacks/<service>` — so an approved request can
 * never read from or write into another service's data, a system path,
 * or anywhere off the box's data volume.
 */
const STACKS_ROOT = '/mnt/data/stacks';

/** A service name must be a single, safe path segment (no separators, no
 *  traversal). Mirrors the MCP/`npmAdminRekey` container-name guard. */
const SERVICE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Reject a `service` name that is not a single safe path segment. A name
 * with a separator or a `..` segment would let `serviceJailRoot` collapse
 * the anchor outside `/mnt/data/stacks/<service>` (e.g. `../../../etc` →
 * `/etc`), silently widening the move jail to a system path. The pure-regex
 * check rejects separators and traversal both; `.` / `..` pass the charset
 * (they are valid segment chars) so we name them explicitly. Mirrors the
 * shape of `assertRestartTarget`'s guard.
 */
function assertServiceName(service: string): void {
  if (typeof service !== 'string' || !SERVICE_NAME_RE.test(service)) {
    throw new Error(`service is not a valid service name: "${service}".`);
  }
  if (service === '.' || service === '..') {
    throw new Error(`service is not a valid service name: "${service}".`);
  }
}

/** Absolute jail root for `service`'s declared move actions on the box. */
function serviceJailRoot(service: string): string {
  return path.posix.join(STACKS_ROOT, service);
}

/**
 * Confine a declared move endpoint to the requesting service's jail
 * (`/mnt/data/stacks/<service>`). Rejects a non-absolute path, a `..`
 * escape, an embedded NUL, and anything that resolves outside the jail
 * (a sibling service, a system dir, the volume root). This is the
 * *authorization* gate — the executor calls themselves are already
 * args-array/shell-quote-safe, so the risk is path scope, not injection.
 *
 * Mirrors the lexical canonicalize-and-boundary approach of
 * `mcp/pathJail.ts`, but anchored to the per-service root rather than the
 * whole data volume, and we require the input to be absolute (a move
 * action names a concrete path on the node, never a relative one).
 */
function jailMovePath(label: 'src' | 'dst', input: string, jailRoot: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`move.${label} is required.`);
  }
  if (input.includes('\0')) {
    throw new Error(`move.${label} contains a NUL byte.`);
  }
  if (!input.startsWith('/')) {
    throw new Error(`move.${label} must be an absolute path: "${input}".`);
  }
  // Collapse `.`/`..` segments lexically, then require the result to stay
  // inside the service's jail (the root itself or a descendant).
  const resolved = path.posix.resolve(input);
  if (resolved !== jailRoot && !resolved.startsWith(`${jailRoot}/`)) {
    throw new Error(
      `move.${label} escapes the service's data jail ${jailRoot}: "${input}" resolves to "${resolved}".`,
    );
  }
  return resolved;
}

/**
 * Confine a declared restart target to the requesting service itself. A
 * request may only bounce its *own* service — never an arbitrary,
 * load-bearing one (basic/authelia/servicebay/…), where a restart can
 * wipe SSO/OIDC clients or take the node's gateway down.
 */
function assertRestartTarget(target: string, service: string): void {
  if (typeof target !== 'string' || !SERVICE_NAME_RE.test(target)) {
    throw new Error(`restart target is not a valid service name: "${target}".`);
  }
  if (target !== service) {
    throw new Error(
      `restart target "${target}" is not the requesting service "${service}"; a request may only restart its own service.`,
    );
  }
}

/** A declared side effect. All fields optional so a request can move a
 *  file, restart a service, dispatch an MCP tool, any combination, or none
 *  (a pure review gate). */
export interface ApprovalAction {
  /** Move `src` → `dst` (absolute POSIX paths on the target node). */
  move?: { src: string; dst: string };
  /** Restart this service (by service name) after the move. */
  restart?: string;
  /**
   * Re-dispatch a destructive MCP tool the agent proposed but could not run
   * itself (#2234). Carried on `on_approve` so approving the request in the
   * operator's Approvals UI actually executes the tool (via the cookie/
   * operator path, which bypasses the destroy gate). `on_reject` leaves this
   * unset, so rejecting simply cancels the proposal without running anything.
   */
  mcp?: { toolName: string; args: Record<string, unknown> };
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  /** Name of the service that submitted the request (informational). */
  service: string;
  title: string;
  description: string | null;
  /** Free-form, service-supplied metadata for the reviewer to inspect. */
  payload: Record<string, unknown>;
  /** Side effect to run when an admin approves. */
  on_approve: ApprovalAction;
  /** Side effect to run when an admin rejects (e.g. move a draft to trash). */
  on_reject: ApprovalAction;
  /** Node the declared actions execute against. */
  node: string;
  created_at: string;
  status: ApprovalStatus;
}

/**
 * Runs a destructive MCP tool by name+args (#2234). Injected by the MCP layer
 * via {@link registerMcpDispatcher} so this kernel module can execute an
 * `on_approve.mcp` action without importing `mcp/server` (which imports this
 * module to submit approvals — a static import both ways would be a cycle).
 */
export type McpToolDispatcher = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

let mcpDispatcher: McpToolDispatcher | null = null;

/** Register the function that executes an MCP-tool approval on approve. */
export function registerMcpDispatcher(fn: McpToolDispatcher): void {
  mcpDispatcher = fn;
}

/** Input accepted by {@link submitApproval}. `id`, `created_at` and `status`
 *  are assigned by the store; everything else is caller-supplied. */
export interface SubmitApprovalInput {
  service: string;
  title: string;
  description?: string | null;
  payload?: Record<string, unknown>;
  on_approve?: ApprovalAction;
  on_reject?: ApprovalAction;
  node?: string;
}

async function readStore(): Promise<ApprovalRequest[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApprovalRequest[]) : [];
  } catch {
    // Missing (fresh box) or corrupt → no pending approvals.
    return [];
  }
}

async function writeStore(requests: ApprovalRequest[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(requests, null, 2), 'utf-8');
  await fs.rename(tmp, STORE_PATH);
}

/** Resolve the node a request targets, defaulting to the first known node. */
async function resolveNode(requested: string | undefined): Promise<string> {
  if (requested && requested !== 'Local') return requested;
  const nodes = await listNodes();
  return nodes[0]?.Name || 'Local';
}

/** List every persisted request (newest first). `[]` on a fresh box. */
export async function listApprovals(): Promise<ApprovalRequest[]> {
  const all = await readStore();
  return [...all].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Fetch a single request by id, or `null` if unknown. */
export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  const all = await readStore();
  return all.find(r => r.id === id) ?? null;
}

/** Persist a new pending request and return it. */
export async function submitApproval(input: SubmitApprovalInput): Promise<ApprovalRequest> {
  // AUTHORIZE the jail anchor at submit time so a traversal-style name
  // (`../../../etc`) never reaches the store — `serviceJailRoot` would
  // otherwise collapse it to a system path on approve.
  assertServiceName(input.service);
  const request: ApprovalRequest = {
    id: randomUUID(),
    service: input.service,
    title: input.title,
    description: input.description ?? null,
    payload: input.payload ?? {},
    on_approve: input.on_approve ?? {},
    on_reject: input.on_reject ?? {},
    node: await resolveNode(input.node),
    created_at: new Date().toISOString(),
    status: 'pending',
  };
  const all = await readStore();
  all.push(request);
  await writeStore(all);
  logger.info(TAG, `submitted approval ${request.id} for service ${request.service}`);
  return request;
}

/**
 * Run a declared action against `node`. The move is executed first (it is
 * the load-bearing side effect); a failed restart afterwards is surfaced as
 * a soft warning rather than rolling back the move (the move is the
 * load-bearing part; the restart is a best-effort nudge).
 */
async function runAction(action: ApprovalAction, node: string, service: string): Promise<{ restarted?: boolean; restartError?: string }> {
  if (action.move) {
    // AUTHORIZE both endpoints into the requesting service's jail BEFORE
    // touching the node — a non-absolute / ../-escape / out-of-jail path
    // throws here and nothing is moved.
    const jailRoot = serviceJailRoot(service);
    const src = jailMovePath('src', action.move.src, jailRoot);
    const dst = jailMovePath('dst', action.move.dst, jailRoot);
    const executor = getExecutor(node);
    if (!(await executor.exists(src))) {
      throw new Error(`Source path not found: ${src}`);
    }
    if (await executor.exists(dst)) {
      throw new Error(`Destination already exists: ${dst}`);
    }
    await executor.mkdir(path.posix.dirname(dst));
    await executor.rename(src, dst);
  }
  if (action.restart) {
    // AUTHORIZE the restart target — must be the requesting service itself.
    assertRestartTarget(action.restart, service);
    try {
      await ServiceManager.restartService(node, action.restart);
      return { restarted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(TAG, `action ran but restart of ${action.restart} failed: ${message}`);
      return { restarted: false, restartError: message };
    }
  }
  if (action.mcp) {
    // Re-dispatch the destructive MCP tool the agent proposed (#2234). This is
    // the LOAD-BEARING side effect for an MCP approval — a failure here must
    // propagate so the operator sees the tool did not run (the caller marks the
    // request approved only after runAction resolves). The dispatcher is
    // injected by the MCP layer (registerMcpDispatcher) so this kernel module
    // never imports mcp/server — that would close an approvals ↔ mcp cycle.
    if (!mcpDispatcher) {
      throw new Error('MCP tool dispatcher is not registered; cannot run this approval.');
    }
    await mcpDispatcher(action.mcp.toolName, action.mcp.args);
  }
  return {};
}

async function resolve(id: string, status: 'approved' | 'rejected', action: ApprovalAction): Promise<{ request: ApprovalRequest; restarted?: boolean; restartError?: string }> {
  const all = await readStore();
  const request = all.find(r => r.id === id);
  if (!request) {
    throw new Error(`Approval request not found: ${id}`);
  }
  if (request.status !== 'pending') {
    throw new Error(`Approval request ${id} is already ${request.status}`);
  }
  const result = await runAction(action, request.node, request.service);
  request.status = status;
  await writeStore(all);
  logger.info(TAG, `${status} approval ${id} (service ${request.service})`);
  return { request, ...result };
}

/** Approve a pending request: run its `on_approve` action, mark approved. */
export async function approveApproval(id: string): Promise<{ request: ApprovalRequest; restarted?: boolean; restartError?: string }> {
  const existing = await getApproval(id);
  if (!existing) throw new Error(`Approval request not found: ${id}`);
  return resolve(id, 'approved', existing.on_approve);
}

/** Reject a pending request: run its `on_reject` action, mark rejected. */
export async function rejectApproval(id: string): Promise<{ request: ApprovalRequest; restarted?: boolean; restartError?: string }> {
  const existing = await getApproval(id);
  if (!existing) throw new Error(`Approval request not found: ${id}`);
  return resolve(id, 'rejected', existing.on_reject);
}
