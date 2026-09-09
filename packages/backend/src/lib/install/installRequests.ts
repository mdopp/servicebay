/**
 * Agent-filed installation *requests* (#2965, security).
 *
 * A coding agent reaching ServiceBay through the read-scoped agent CLI
 * (`agent-cli/servicebay.mjs`) finishes a template and then stops: it has no
 * way to ask for anything to happen. The operator's decision of 2026-09-09 was
 * explicitly **not** to give the CLI an install verb — anyone who reaches the
 * pi web surface would then reach deployment — but to give it a way to
 * **request** an installation that ServiceBay executes only after the operator
 * has approved it.
 *
 * ## Which approval store this reuses, and why
 *
 * The durable approvals kernel (`@/lib/approvals`, #1843) — the same store
 * behind Settings → Approvals and the Home "Pending approvals" card. It
 * already carries every property this flow needs and nothing it does not:
 *
 *   - a **declared side effect** the operator's Approve runs (`on_approve`),
 *     so the agent proposes and ServiceBay executes — the #2234 shape;
 *   - a **self-approve guard** (`isSelfApproval`, #2244) keyed on
 *     `payload.caller`, so the principal that filed the request cannot deliver
 *     its own verdict;
 *   - an **operator-visible record** — title, description and payload — which
 *     is where criterion 2's "the operator sees exactly what would be
 *     installed" lands;
 *   - durability across restarts, an event for the Solaris feed, and a
 *     recorded execution outcome (#2653) so a failure is knowable.
 *
 * The three alternatives were weighed and rejected: `config.accessRequests` is
 * the LLDAP *user-onboarding* queue (it demands a `username` and provisions an
 * account); `auth/tokenRequests` is about *issuing a credential*, and its
 * one-shot path already parks in this very store when it needs an operator;
 * learning proposals are a knowledge surface with a diff/merge review model.
 * This file therefore adds a request *store* beside the installer — the way
 * `tokenRequests.ts` sits beside `apiTokens.ts` — and parks the decision in the
 * approvals kernel rather than inventing a fourth approval mechanism.
 *
 * ## The seal — what executes is what was APPROVED
 *
 * The row this store keeps is what the *agent asked for*. It is never what
 * runs. On Approve the kernel calls {@link sealApprovedInstallRequest}, which
 * copies the plan **out of the approval record the operator actually read**
 * (`payload.plan`) onto the row as `approvedPlan`, fingerprints it, and only
 * then schedules execution. {@link executeApprovedInstallRequest} runs
 * `approvedPlan` and refuses if its fingerprint no longer matches — so neither
 * a later rewrite of `plan` nor a tamper with `approvedPlan` itself can widen
 * the reach of an approval that has already been given.
 *
 * ## Non-destructive by construction (ADR 0004)
 *
 * `wipeMode` is not a field of a request and cannot be asked for: execution
 * hard-codes `'install'`. An agent-filed request can add a service; it can
 * never wipe one.
 */
import fsp from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { atomicWriteFile } from '@/lib/util/atomicWrite';
import { logger } from '@/lib/logger';
import { getApproval, submitApproval, registerInstallSealer } from '@/lib/approvals';

const TAG = 'install:requests';
const STORE_PATH = path.join(DATA_DIR, 'install-requests.json');

/** Anti-spam cap on outstanding pending install requests (mirrors
 *  MAX_PENDING_TOKEN_REQUESTS): a hostile agent cannot fill the disk. */
export const MAX_PENDING_INSTALL_REQUESTS = 25;

/** A service/template name must be a single safe path segment — same guard as
 *  the approvals store's jail anchor and the MCP container-name check. */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/** A subdomain label: DNS-safe, no dots (one label under the box's domain). */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A template variable name the wizard would accept. */
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variable names an agent may never set through this path (#2965, hygiene).
 *
 * A template expresses its secrets as `type: "secret"` variables and the
 * wizard generates them at deploy time; an agent carrying a literal password
 * or token into a request would put it in `install-requests.json`, in
 * `approvals.json`, and on the operator's screen. Refuse at submit rather than
 * redact later.
 */
const SECRET_ISH_VARIABLE_RE = /(PASS|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/** Ports below this are privileged and are never granted to an agent request. */
const MIN_REQUESTABLE_PORT = 1024;

/** Per-service data root on the box — a requested mount must live under it. */
const STACKS_ROOT = '/mnt/data/stacks';

/** How many mounts/ports/variables one request may declare. */
const MAX_LIST_ENTRIES = 20;

export interface InstallMount {
  /** Absolute path on the box. Confined to `/mnt/data/stacks/<serviceName>`. */
  host: string;
  /** Absolute path inside the container. */
  container: string;
  mode?: 'ro' | 'rw';
}

export interface InstallPort {
  host: number;
  container: number;
  protocol?: 'tcp' | 'udp';
}

/**
 * Exactly what would be installed — the five things acceptance criterion 2
 * names, and nothing the operator cannot read off the approval card.
 */
export interface InstallRequestPlan {
  /** Template/stack name to install. */
  template: string;
  /** Where to resolve the template from ("Built-in", "Local", a registry). */
  templateSource?: string;
  /** The service name the agent intends this to become. */
  serviceName: string;
  /** Requested public subdomain label, or null for none. */
  subdomain: string | null;
  /** Host↔container mounts the agent is asking for. */
  mounts: InstallMount[];
  /** Host↔container ports the agent is asking for. */
  ports: InstallPort[];
  /** Non-secret template variable overrides. */
  variables: Record<string, string>;
  /** Target node; omitted means the box's default node. */
  node?: string;
}

export type InstallRequestStatus =
  | 'pending'
  | 'approved'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'denied';

export interface InstallRequest {
  id: string;
  /**
   * The principal that filed it, taken from the authenticated session — never
   * from the request body. Binding is one-way and total: only this principal
   * may read the request's state, and the request is recorded as this
   * principal's proposal for the self-approve guard.
   */
  requestedBy: string;
  reason: string;
  /** What the agent ASKED for. Never what runs — see `approvedPlan`. */
  plan: InstallRequestPlan;
  status: InstallRequestStatus;
  createdAt: string;
  /** The durable approval that gates it. */
  approvalId: string;
  /** Frozen at Approve, out of the approval record the operator read. */
  approvedPlan?: InstallRequestPlan;
  /** Fingerprint of `approvedPlan`, re-checked before execution. */
  approvedPlanDigest?: string;
  approvedAt?: string;
  /** Install job id, once execution has started. */
  jobId?: string;
  /** Failure detail, when status is `failed`. */
  error?: string;
}

export class InstallRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'InstallRequestError';
  }
}

/* ------------------------------------------------------------------ *
 * store
 * ------------------------------------------------------------------ */

async function readStore(): Promise<InstallRequest[]> {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstallRequest[]) : [];
  } catch {
    return []; // missing (fresh box) or corrupt → nothing pending
  }
}

async function writeStore(requests: InstallRequest[]): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await atomicWriteFile(STORE_PATH, JSON.stringify(requests, null, 2));
  try { await fsp.chmod(STORE_PATH, 0o600); } catch { /* best-effort */ }
}

/* ------------------------------------------------------------------ *
 * the fingerprint
 * ------------------------------------------------------------------ */

/** Canonical JSON — object keys sorted at every depth, so two structurally
 *  equal plans always fingerprint identically regardless of key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Fingerprint of an approved plan. Not a signature — the store file is
 *  mode-0600 and root-owned — but it makes a tamper with the sealed copy a
 *  refusal instead of an execution. */
export function planDigest(plan: InstallRequestPlan): string {
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

/* ------------------------------------------------------------------ *
 * validation — a request cannot ask for reach it should not have
 * ------------------------------------------------------------------ */

function assertSafeName(label: string, value: unknown): string {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value) || value === '.' || value === '..') {
    throw new InstallRequestError(`${label} is not a valid name: ${JSON.stringify(value)}`, 400);
  }
  return value;
}

/**
 * Normalise + authorize the requested plan.
 *
 * Every rejection here is a reach the request may not have in the first place,
 * so the operator is never shown a card asking them to approve one: a mount
 * outside the service's own data jail, a privileged port, a secret-shaped
 * variable, a wipe of any kind.
 */
export function normalizeInstallPlan(input: unknown): InstallRequestPlan {
  if (!input || typeof input !== 'object') {
    throw new InstallRequestError('plan is required', 400);
  }
  const raw = input as Record<string, unknown>;

  if ('wipeMode' in raw) {
    throw new InstallRequestError(
      'A requested install may never carry a wipeMode: an agent-filed request adds a service, it never wipes one (ADR 0004).',
      400,
    );
  }

  const template = assertSafeName('plan.template', raw.template);
  const serviceName = assertSafeName('plan.serviceName', raw.serviceName);

  let templateSource: string | undefined;
  if (raw.templateSource !== undefined && raw.templateSource !== null) {
    if (typeof raw.templateSource !== 'string' || raw.templateSource.length > 120) {
      throw new InstallRequestError('plan.templateSource must be a short string', 400);
    }
    templateSource = raw.templateSource;
  }

  let subdomain: string | null = null;
  if (raw.subdomain !== undefined && raw.subdomain !== null && raw.subdomain !== '') {
    if (typeof raw.subdomain !== 'string' || !SUBDOMAIN_RE.test(raw.subdomain)) {
      throw new InstallRequestError(
        `plan.subdomain must be a single DNS label (got ${JSON.stringify(raw.subdomain)})`,
        400,
      );
    }
    subdomain = raw.subdomain;
  }

  const jailRoot = path.posix.join(STACKS_ROOT, serviceName);
  const mountsIn = raw.mounts === undefined ? [] : raw.mounts;
  if (!Array.isArray(mountsIn) || mountsIn.length > MAX_LIST_ENTRIES) {
    throw new InstallRequestError(`plan.mounts must be an array of at most ${MAX_LIST_ENTRIES} entries`, 400);
  }
  const mounts: InstallMount[] = mountsIn.map((entry, i) => {
    const m = entry as Record<string, unknown>;
    const host = m?.host;
    const container = m?.container;
    if (typeof host !== 'string' || !host.startsWith('/') || host.includes('\0')) {
      throw new InstallRequestError(`plan.mounts[${i}].host must be an absolute path on the box`, 400);
    }
    const resolved = path.posix.resolve(host);
    if (resolved !== jailRoot && !resolved.startsWith(`${jailRoot}/`)) {
      throw new InstallRequestError(
        `plan.mounts[${i}].host escapes the service's data jail ${jailRoot}: "${host}" resolves to "${resolved}". `
        + 'A requested install may only mount its own service data.',
        400,
      );
    }
    if (typeof container !== 'string' || !container.startsWith('/') || container.includes('\0')) {
      throw new InstallRequestError(`plan.mounts[${i}].container must be an absolute path in the container`, 400);
    }
    const mode = m?.mode;
    if (mode !== undefined && mode !== 'ro' && mode !== 'rw') {
      throw new InstallRequestError(`plan.mounts[${i}].mode must be "ro" or "rw"`, 400);
    }
    return { host: resolved, container, ...(mode ? { mode: mode as 'ro' | 'rw' } : {}) };
  });

  const portsIn = raw.ports === undefined ? [] : raw.ports;
  if (!Array.isArray(portsIn) || portsIn.length > MAX_LIST_ENTRIES) {
    throw new InstallRequestError(`plan.ports must be an array of at most ${MAX_LIST_ENTRIES} entries`, 400);
  }
  const ports: InstallPort[] = portsIn.map((entry, i) => {
    const p = entry as Record<string, unknown>;
    const host = p?.host;
    const container = p?.container;
    for (const [key, value] of [['host', host], ['container', container]] as const) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
        throw new InstallRequestError(`plan.ports[${i}].${key} must be a port number`, 400);
      }
    }
    if ((host as number) < MIN_REQUESTABLE_PORT) {
      throw new InstallRequestError(
        `plan.ports[${i}].host ${host} is privileged (<${MIN_REQUESTABLE_PORT}); a requested install may not bind one.`,
        400,
      );
    }
    const protocol = p?.protocol;
    if (protocol !== undefined && protocol !== 'tcp' && protocol !== 'udp') {
      throw new InstallRequestError(`plan.ports[${i}].protocol must be "tcp" or "udp"`, 400);
    }
    return {
      host: host as number,
      container: container as number,
      ...(protocol ? { protocol: protocol as 'tcp' | 'udp' } : {}),
    };
  });

  const variablesIn = (raw.variables ?? {}) as Record<string, unknown>;
  if (typeof variablesIn !== 'object' || Array.isArray(variablesIn)) {
    throw new InstallRequestError('plan.variables must be an object of name→value', 400);
  }
  const names = Object.keys(variablesIn);
  if (names.length > MAX_LIST_ENTRIES) {
    throw new InstallRequestError(`plan.variables may hold at most ${MAX_LIST_ENTRIES} entries`, 400);
  }
  const variables: Record<string, string> = {};
  for (const name of names.sort()) {
    if (!VARIABLE_NAME_RE.test(name)) {
      throw new InstallRequestError(`plan.variables has an invalid name ${JSON.stringify(name)}`, 400);
    }
    if (SECRET_ISH_VARIABLE_RE.test(name)) {
      throw new InstallRequestError(
        `plan.variables.${name} looks like a secret. A template declares its secrets as type:"secret" variables and `
        + 'ServiceBay generates them at deploy time; a request never carries one.',
        400,
      );
    }
    const value = variablesIn[name];
    if (typeof value !== 'string' || value.length > 512) {
      throw new InstallRequestError(`plan.variables.${name} must be a string of at most 512 characters`, 400);
    }
    variables[name] = value;
  }

  let node: string | undefined;
  if (raw.node !== undefined && raw.node !== null && raw.node !== '') {
    node = assertSafeName('plan.node', raw.node);
  }

  return {
    template,
    ...(templateSource ? { templateSource } : {}),
    serviceName,
    subdomain,
    mounts,
    ports,
    variables,
    ...(node ? { node } : {}),
  };
}

/** One line per declared reach, for the operator's card. */
function describePlan(plan: InstallRequestPlan): string {
  const mounts = plan.mounts.length
    ? plan.mounts.map(m => `${m.host} → ${m.container}${m.mode ? ` (${m.mode})` : ''}`).join(', ')
    : 'none';
  const ports = plan.ports.length
    ? plan.ports.map(p => `${p.host}→${p.container}/${p.protocol ?? 'tcp'}`).join(', ')
    : 'none';
  const variables = Object.keys(plan.variables).length
    ? Object.entries(plan.variables).map(([k, v]) => `${k}=${v}`).join(', ')
    : 'none';
  return [
    `Template: ${plan.template}${plan.templateSource ? ` (from ${plan.templateSource})` : ''}`,
    `Service name: ${plan.serviceName}`,
    `Subdomain: ${plan.subdomain ?? 'none'}`,
    `Mounts: ${mounts}`,
    `Ports: ${ports}`,
    `Variables: ${variables}`,
  ].join(' · ');
}

/* ------------------------------------------------------------------ *
 * submit
 * ------------------------------------------------------------------ */

/**
 * File a pending installation request and park the decision in the durable
 * approvals store. Installs nothing, changes nothing on the box.
 *
 * `requestedBy` is the authenticated principal — the caller must pass the
 * session's own identity, never a body field — and is recorded twice on
 * purpose: on the row (so only that principal can read the request back) and
 * as the approval's `payload.caller` (so the self-approve guard refuses the
 * requester delivering its own verdict).
 */
export async function submitInstallRequest(input: {
  plan: unknown;
  reason: string;
  requestedBy: string;
}): Promise<InstallRequest> {
  const requestedBy = (input.requestedBy ?? '').trim();
  if (!requestedBy) {
    throw new InstallRequestError('requestedBy (the authenticated principal) is required', 403);
  }
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new InstallRequestError('reason is required', 400);
  const plan = normalizeInstallPlan(input.plan);

  const all = await readStore();
  const pending = all.filter(r => r.status === 'pending');
  if (pending.length >= MAX_PENDING_INSTALL_REQUESTS) {
    throw new InstallRequestError(
      `Too many pending install requests (${pending.length}/${MAX_PENDING_INSTALL_REQUESTS}). `
      + 'The operator must resolve existing ones first.',
      409,
    );
  }

  const id = randomUUID();
  const approval = await submitApproval({
    service: plan.serviceName,
    title: `install ${plan.template} as ${plan.serviceName}`,
    description:
      `An agent (${requestedBy}) asks ServiceBay to install this template. Nothing has been installed; approving is `
      + `what runs it, and what runs is exactly the plan below. ${describePlan(plan)}. Reason: ${reason.slice(0, 300)}`,
    // `caller` drives the self-approve guard (isSelfApproval reads it);
    // `plan` is the operator-visible copy AND the copy that gets sealed.
    payload: { kind: 'install-request', caller: requestedBy, installRequestId: id, plan },
    on_approve: { sealInstall: { installRequestId: id } },
    ...(plan.node ? { node: plan.node } : {}),
  });

  const request: InstallRequest = {
    id,
    requestedBy: requestedBy.slice(0, 120),
    reason: reason.slice(0, 1000),
    plan,
    status: 'pending',
    createdAt: new Date().toISOString(),
    approvalId: approval.id,
  };
  all.push(request);
  await writeStore(all);
  logger.info(
    TAG,
    `filed install request ${id} template=${plan.template} service=${plan.serviceName} by ${requestedBy} approval=${approval.id}`,
  );
  return request;
}

/** Every request, newest first. */
export async function listInstallRequests(): Promise<InstallRequest[]> {
  const all = await readStore();
  return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------------------------------------------ *
 * read back — principal-bound both ways
 * ------------------------------------------------------------------ */

/** What a requester learns when it polls. Never claims success while waiting. */
export interface InstallRequestState {
  id: string;
  /** `pending` | `approved` | `installing` | `installed` | `failed` | `denied`. */
  status: InstallRequestStatus;
  /** True only when the install actually ran to completion. */
  installed: boolean;
  /** One line the agent can act on — never "ok" while nothing has happened. */
  detail: string;
  jobId?: string;
  error?: string;
}

/**
 * Read one request's real state, bound to the principal that filed it.
 *
 * A different principal gets a 403, not a 404-shaped shrug and not the record:
 * the request is a statement of intent tied to an identity, and letting a
 * second agent redeem or even observe it would break that binding.
 */
export async function getInstallRequestState(id: string, principal: string): Promise<InstallRequestState> {
  const all = await readStore();
  const req = all.find(r => r.id === id);
  if (!req) throw new InstallRequestError(`Install request not found: ${id}`, 404);
  if (!principal || req.requestedBy !== principal) {
    throw new InstallRequestError(
      `Install request ${id} belongs to another principal; it can only be read by the one that filed it.`,
      403,
    );
  }

  // While the row is still pending, the approval record is the authority on
  // whether the operator has already said no.
  let status = req.status;
  if (status === 'pending') {
    const approval = await getApproval(req.approvalId);
    if (approval?.status === 'rejected') status = 'denied';
  }

  const detail = {
    pending: 'waiting for the operator to approve — NOTHING has been installed',
    approved: 'approved; ServiceBay is about to run it — nothing is installed yet',
    installing: 'ServiceBay is installing it now',
    installed: 'installed',
    failed: 'the approved install ran and failed',
    denied: 'the operator rejected it — nothing was installed',
  }[status];

  return {
    id: req.id,
    status,
    installed: status === 'installed',
    detail,
    ...(req.jobId ? { jobId: req.jobId } : {}),
    ...(req.error ? { error: req.error } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * seal + execute
 * ------------------------------------------------------------------ */

/**
 * Seal the plan the operator approved onto the request, then schedule it.
 *
 * Registered as the approvals kernel's `on_approve.sealInstall` action, so it
 * runs on the operator's Approve and nowhere else. The sealed plan is taken
 * from the APPROVAL record — the exact object rendered on the card the
 * operator read — not from the request row, which the requester's own writes
 * shape. Everything downstream reads the seal.
 *
 * Throws (so the approval is NOT marked approved) when the request is unknown,
 * already resolved, or the approval carries no plan.
 */
export async function sealApprovedInstallRequest(installRequestId: string): Promise<void> {
  const all = await readStore();
  const req = all.find(r => r.id === installRequestId);
  if (!req) throw new InstallRequestError(`Install request not found: ${installRequestId}`, 404);
  if (req.status !== 'pending') {
    throw new InstallRequestError(`Install request ${installRequestId} is already ${req.status}`, 409);
  }
  const approval = await getApproval(req.approvalId);
  const shown = approval?.payload?.plan;
  if (!shown) {
    throw new InstallRequestError(
      `Approval ${req.approvalId} carries no plan; refusing to install something the operator was not shown.`,
      409,
    );
  }
  // Re-normalise the operator-visible copy: the seal is a validated plan even
  // if the record on disk were ever hand-edited.
  const sealed = normalizeInstallPlan(shown);

  req.status = 'approved';
  req.approvedPlan = sealed;
  req.approvedPlanDigest = planDigest(sealed);
  req.approvedAt = new Date().toISOString();
  await writeStore(all);
  logger.info(TAG, `sealed install request ${installRequestId} digest=${req.approvedPlanDigest.slice(0, 12)}`);

  // Execution is deliberately scheduled rather than awaited: an install is
  // minutes long and the approvals kernel holds its store mutex around this
  // action. The requester polls for the real state (never "ok" while waiting).
  scheduleExecution(installRequestId);
}

/** Overridable so a test can drive execution itself; production schedules it. */
let scheduleExecution: (id: string) => void = id => {
  void executeApprovedInstallRequest(id).catch(err => {
    logger.error(TAG, `scheduled install for request ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
};

/** Test seam: replace the post-seal scheduler (e.g. to run execution by hand). */
export function setInstallScheduler(fn: (id: string) => void): void {
  scheduleExecution = fn;
}

/** What execution hands to the installer. `wipeMode` is not part of it. */
export interface InstallStart {
  names: string[];
  templateSource?: string;
  variables: Record<string, string>;
  node?: string;
}

/** The real installer: assemble the manifest, create the job, start it. */
async function defaultStartInstall(start: InstallStart): Promise<string> {
  const [{ assembleManifest, applyVariableDefaults }, { createJob }, { startJob }] = await Promise.all([
    import('./manifestAssembler'),
    import('./jobStore'),
    import('./runner'),
  ]);
  const assembled = await assembleManifest({
    items: start.names.map(name => ({ name, checked: true })),
    prefilled: start.variables,
    templateSource: start.templateSource,
  });
  const withDefaults = await applyVariableDefaults({
    items: assembled.items,
    variables: assembled.variables,
    templateSource: start.templateSource ?? 'Built-in',
    host: 'localhost',
    // ADR 0004: an agent-filed install is additive, always.
    wipeMode: 'install',
    ...(start.node ? { node: start.node } : {}),
  }, start.templateSource);
  const job = await createJob({ source: 'mcp', input: withDefaults });
  startJob(job.id);
  return job.id;
}

/**
 * Run the APPROVED plan.
 *
 * Reads `approvedPlan` — never `plan` — and refuses if the sealed copy's
 * fingerprint no longer matches, so a rewrite of either copy after the
 * operator decided is a refusal rather than a wider install.
 */
export async function executeApprovedInstallRequest(
  id: string,
  deps: { startInstall?: (start: InstallStart) => Promise<string> } = {},
): Promise<InstallRequestState> {
  const startInstall = deps.startInstall ?? defaultStartInstall;

  let all = await readStore();
  let req = all.find(r => r.id === id);
  if (!req) throw new InstallRequestError(`Install request not found: ${id}`, 404);
  if (req.status !== 'approved') {
    throw new InstallRequestError(
      `Install request ${id} is ${req.status}, not approved; only an approved request executes.`,
      409,
    );
  }
  const sealed = req.approvedPlan;
  if (!sealed || !req.approvedPlanDigest) {
    throw new InstallRequestError(`Install request ${id} carries no approved plan; refusing to install.`, 409);
  }
  if (planDigest(sealed) !== req.approvedPlanDigest) {
    throw new InstallRequestError(
      `Install request ${id}: the approved plan no longer matches its fingerprint — it was altered after approval. Refusing to install.`,
      409,
    );
  }

  req.status = 'installing';
  await writeStore(all);

  const start: InstallStart = {
    names: [sealed.template],
    ...(sealed.templateSource ? { templateSource: sealed.templateSource } : {}),
    variables: sealed.variables,
    ...(sealed.node ? { node: sealed.node } : {}),
  };

  let jobId: string | undefined;
  let failure: string | undefined;
  try {
    jobId = await startInstall(start);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // Re-read: the row may have been rewritten while the installer ran.
  all = await readStore();
  req = all.find(r => r.id === id);
  if (!req) throw new InstallRequestError(`Install request vanished during execution: ${id}`, 404);
  if (failure) {
    req.status = 'failed';
    req.error = failure.slice(0, 500);
    logger.error(TAG, `install request ${id} failed: ${req.error}`);
  } else {
    req.status = 'installed';
    req.jobId = jobId;
    logger.info(TAG, `install request ${id} started job ${jobId} from the sealed plan`);
  }
  await writeStore(all);

  return getInstallRequestState(id, req.requestedBy);
}

// Wire the sealer into the approvals kernel at module load, symmetric with
// tokenRequests.ts's registerTokenMinter call: an approved `sealInstall`
// action then seals + schedules through this module.
registerInstallSealer(sealApprovedInstallRequest);
