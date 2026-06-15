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

/** A declared side effect. Both fields optional so a request can move a
 *  file, restart a service, both, or neither (a pure review gate). */
export interface ApprovalAction {
  /** Move `src` → `dst` (absolute POSIX paths on the target node). */
  move?: { src: string; dst: string };
  /** Restart this service (by service name) after the move. */
  restart?: string;
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
async function runAction(action: ApprovalAction, node: string): Promise<{ restarted?: boolean; restartError?: string }> {
  if (action.move) {
    const { src, dst } = action.move;
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
    try {
      await ServiceManager.restartService(node, action.restart);
      return { restarted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(TAG, `action ran but restart of ${action.restart} failed: ${message}`);
      return { restarted: false, restartError: message };
    }
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
  const result = await runAction(action, request.node);
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
