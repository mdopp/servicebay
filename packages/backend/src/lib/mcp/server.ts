import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  getStoreSnapshot,
  getServices,
  getContainers,
  getNodeTwin,
  getUnmanagedBundles,
} from '@/lib/store/repository';
import {
  getAllSystemServices,
} from '@/lib/manager';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getTemplates, getReadme, getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { listAssists, getAssist, ASSIST_KINDS } from '@/lib/assists/catalog';
import { listNodes, getNodeConnection } from '@/lib/nodes';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { agentManager } from '@/lib/agent/manager';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import type { CheckConfig, CheckType } from '@/lib/health/types';
import { getConfig, updateConfig, type AppConfig, type ProxyHostEntry, type AccessRequest } from '@/lib/config';
import {
  getBackupHistory,
  runBackup as runBackupService,
  isBackupRunning,
} from '@/lib/backup/service';
import { restoreSystemBackup } from '@/lib/systemBackup';
import { getServicebayChannel, setServicebayChannel } from '@/lib/servicebayChannel';
import { guardMutation, guardExec, snapshotBeforeMutation } from './safety';
import { recordAudit } from './audit';
import { notifyDestructiveOp } from './notify';
import { submitApproval, registerMcpDispatcher } from '@/lib/approvals';
import { dispatchWithServer } from './dispatchTool';
import { redactLogText, redactServiceFiles } from './redact';
import { type ApiScope, scopeSatisfiedBy, ALL_SCOPES } from '@/lib/auth/apiScope';
import {
  submitTokenRequest,
  pollTokenRequest,
  listTokenRequests,
  MAX_TTL_SECS,
  TokenRequestError,
  type TokenRequestStatus,
} from '@/lib/auth/tokenRequests';
import { parseEfibootmgr, assessUsbBootReadiness } from './efibootmgr';
import { performStackReset, StackResetError } from '@/lib/install/performStackReset';
import { jailPath, realPathInJail, JAIL_ROOT } from './pathJail';
import { largestDirsUnderDataDir } from '@/lib/diagnose/probes/disk';
import { AgentExecutor } from '@/lib/agent/executor';
import { shellQuote } from '@/lib/util/shellQuote';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { AUTHELIA_FORWARD_AUTH_SENTINEL } from '@/lib/stackInstall/forwardAuth';
import { assembleManifest, applyVariableDefaults } from '@/lib/install/manifestAssembler';
import {
  createJob,
  getJob,
  readLog,
  getCurrentJob,
  InstallInProgressError,
  type JobInput,
  type WipeMode,
} from '@/lib/install/jobStore';
import { startJob } from '@/lib/install/runner';

/**
 * Loopback fetch to this process's own Next API, carrying the internal
 * API token so proxy.ts's CSRF/session gate accepts the state-changing
 * call (no cookie, no Origin). Same pattern as the install runner's
 * `apiFetch` (postInstallDispatcher.ts) — used by the MCP proxy/install
 * tools that reuse the install-runner HTTP wiring (#2140/#2141).
 */
function loopbackFetch(path: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}

interface McpAuthContext {
  user: string;
  scopes: ApiScope[];
  tokenId?: string;
}

// Wire the approvals kernel's MCP-tool re-dispatch (#2234) to a no-auth
// (operator) MCP server. Registered at module load — server.ts is loaded at
// process startup — so approving a persisted MCP approval runs the tool. The
// dispatcher closes over `createMcpServer` here rather than dispatchTool.ts
// importing server.ts, which would close an approvals ↔ mcp dependency cycle.
registerMcpDispatcher((toolName, args) => dispatchWithServer(() => createMcpServer(), toolName, args));

const nodeParam = z.string().optional().describe('Node name (defaults to first available node)');

async function resolveNode(node?: string): Promise<string> {
  if (node) return node;
  const nodes = await listNodes();
  return nodes[0]?.Name || 'Local';
}

function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
}

/**
 * Confirm a jailed path's REAL path (after symlink resolution on the box)
 * is still inside JAIL_ROOT. Returns an error message string if it
 * escapes, else null. Shared by read_file + list_dir (#1872) so the
 * symlink-escape guard lives in one place.
 */
async function assertRealpathInJail(
  exec: AgentExecutor,
  jailedPath: string,
  reqPath: string,
): Promise<string | null> {
  // Resolve BOTH the target and the jail root on the box. On Fedora CoreOS
  // JAIL_ROOT (/mnt/data) is itself a symlink to /var/mnt/data, so the
  // target resolves to /var/mnt/data/… and must be compared against the
  // *resolved* root, not the literal string (else every legit path is
  // wrongly rejected — #1872 2nd box-verify RED).
  const [real, rootReal] = await Promise.all([
    exec.execSafe(['realpath', '-m', '--', jailedPath]),
    exec.execSafe(['realpath', '-m', '--', JAIL_ROOT]),
  ]);
  if (realPathInJail(real.stdout ?? '', rootReal.stdout ?? '')) return null;
  return `Path escapes the allowed root ${JAIL_ROOT}: "${reqPath}" resolves (via symlink) to "${(real.stdout ?? '').trim()}".`;
}

/**
 * Stat a jailed file and confirm it is a regular file within `limit`
 * bytes (rejects device nodes, dirs, and oversized blobs before we slurp
 * them through the agent). Returns an error message string, else null.
 */
async function assertReadableRegularFile(
  exec: AgentExecutor,
  jailedPath: string,
  reqPath: string,
  limit: number,
): Promise<string | null> {
  const stat = await exec.execSafe(['stat', '-Lc', '%F %s', '--', jailedPath]);
  if (stat.code !== 0) {
    return `Cannot stat "${reqPath}": ${(stat.stderr ?? '').trim() || `exit ${stat.code}`}`;
  }
  const [kind, sizeStr] = (stat.stdout ?? '').trim().split(/\s+/);
  if (kind !== 'regular' && kind !== 'regular_empty_file') {
    return `Refusing to read "${reqPath}": not a regular file (${kind}).`;
  }
  const size = Number(sizeStr);
  if (Number.isFinite(size) && size > limit) {
    return `File "${reqPath}" is ${size} bytes, over the ${limit}-byte cap. Raise maxBytes or use exec_command.`;
  }
  return null;
}

/**
 * Tools that mutate state. Calls are gated on `config.mcp.allowMutations`
 * (true | absent ⇒ allowed; false ⇒ blocked).
 */
const MUTATING_TOOLS = new Set([
  'start_service', 'stop_service', 'restart_service',
  'deploy_service', 'delete_service', 'rename_service', 'update_service_yaml',
  'restore_trashed_service', 'purge_trashed_service',
  'add_proxy_route', 'create_proxy_route', 'remove_proxy_route',
  'write_file', 'install_template',
  'file_access_request',
  'create_health_check', 'delete_health_check', 'run_check_now',
  'run_backup', 'restore_backup',
  'update_config', 'exec_command', 'container_exec', 'refresh_agent',
  'set_boot_next_usb', 'reboot_node', 'factory_reset',
  'set_channel',
]);

/**
 * Per-tool required scope. Bearer-token auth refuses any tool whose scope
 * isn't in the token's set. Cookie auth has all scopes for back-compat.
 *
 *   read       lookups + diagnose + log readers
 *   lifecycle  start/stop/restart + run_check_now + refresh + run_backup
 *   mutate     create/update/add + config writes — additive changes
 *   reboot     reboot_node — transient, recoverable host restart (#1765),
 *              split off `destroy` so a token can operate+reboot without
 *              also granting irreversible delete/wipe. `destroy` implies it.
 *   destroy    delete/restore/purge/factory_reset — irreversible state edits
 *   exec       exec_command — split off from `destroy` (#591) so a token
 *              can grant config writes without shell access
 */
export const TOOL_SCOPES: Record<string, ApiScope> = {
  // read
  list_nodes: 'read', list_services: 'read', list_containers: 'read',
  get_service_logs: 'read', get_container_logs: 'read', get_service_files: 'read',
  list_templates: 'read', get_template_readme: 'read', get_template_yaml: 'read',
  get_template_variables: 'read',
  list_assists: 'read', get_assist: 'read',
  get_system_info: 'read', get_network_graph: 'read', get_health_checks: 'read',
  get_gateway_status: 'read', get_proxy_routes: 'read', get_config: 'read',
  get_podman_logs: 'read', list_system_services: 'read',
  list_backups: 'read', diagnose: 'read', verify_node_connection: 'read',
  verify_usb_boot: 'read',
  list_trashed_services: 'read',
  get_unmanaged_bundles: 'read',
  get_channel: 'read',
  list_access_requests: 'read', get_access_request_status: 'read',
  // Scoped-token request flow (#2139). A token *request* itself grants
  // nothing — it just files a pending item the admin must approve — so it
  // needs only the lowest scope (`read`). This is deliberate: a caller with
  // no token at all can't invoke MCP tools, but a caller holding even a
  // read-only token can ASK for a broader, short-lived grant that a human
  // signs off on. Making request_token require a high scope would defeat the
  // point (you'd need the very authority you're trying to request).
  request_token: 'read', poll_token_request: 'read', list_token_requests: 'read',
  // read-oriented file/disk tools (#1872) — jailed reads, no mutation
  read_file: 'read', list_dir: 'read', disk_usage: 'read',
  // install progress is a read-only poll of a job's state (#2141)
  get_install_progress: 'read',
  // lifecycle
  start_service: 'lifecycle', stop_service: 'lifecycle', restart_service: 'lifecycle',
  run_check_now: 'lifecycle', refresh_agent: 'lifecycle',
  run_backup: 'lifecycle',
  set_channel: 'lifecycle',
  // mutate
  deploy_service: 'mutate', update_service_yaml: 'mutate', rename_service: 'mutate',
  add_proxy_route: 'mutate', create_health_check: 'mutate',
  // #2140 create_proxy_route (full NPM host: exposure + forward-auth + cert)
  // and #2141 install_template (assemble→start a wizard install) and #2142
  // write_file are all additive provisioning ops → `mutate`, NOT `destroy`.
  create_proxy_route: 'mutate', install_template: 'mutate', write_file: 'mutate',
  restore_trashed_service: 'mutate',
  file_access_request: 'mutate',
  // mutate (config writes, allow-listed to safe keys — see update_config tool)
  update_config: 'mutate',
  // destroy
  delete_service: 'destroy', delete_health_check: 'destroy',
  remove_proxy_route: 'destroy', restore_backup: 'destroy',
  purge_trashed_service: 'destroy',
  // set_boot_next_usb stays `destroy`: it can arm a USB-installer boot, a
  // reinstall path that risks data loss — higher-risk than a plain reboot.
  set_boot_next_usb: 'destroy',
  factory_reset: 'destroy',
  // reboot — transient, recoverable; split out of destroy (#1765)
  reboot_node: 'reboot',
  // exec (shell — own scope so tokens can grant config writes without it)
  exec_command: 'exec',
  // container_exec (#1872): runs a command inside a named container via an
  // argv array (no host shell). It executes code, so it requires the `exec`
  // scope like exec_command — but it's a scoped container exec, not the host
  // escape hatch, and is read-oriented per the issue, so it is deliberately
  // NOT in DESTRUCTIVE_TOOLS (no pre-mutation host snapshot).
  container_exec: 'exec',
};

/**
 * Decide whether a token with `tokenScopes` may call a tool that
 * requires `required`. Encapsulates the back-compat rules:
 *   - tokens issued before the exec split (#591) — when `exec_command`
 *     was tagged `destroy` — still get exec via their `destroy` grant.
 *   - `destroy` implies `reboot` (#1765): the reboot tier was carved out
 *     of `destroy`, so a legacy `destroy` token can still reboot a node.
 *
 * Exported pure helper so the scope semantics are testable without
 * spinning up the whole MCP server.
 */
export function tokenHasScope(tokenScopes: readonly ApiScope[], required: ApiScope): boolean {
  // Single-sourced scope-implication ladder lives in apiScope.ts (#2048) so
  // the delegated-mint subset check and this MCP gate can't drift.
  return scopeSatisfiedBy(tokenScopes, required);
}

/**
 * Subset of MUTATING_TOOLS that can lose data or change config in
 * non-trivially-reversible ways. These trigger an automatic
 * pre-mutation system snapshot so the operator always has a one-click
 * rewind point.
 *
 * Note: `delete_service` is now soft (moves to trash, recoverable for 7d
 * via restore_trashed_service), so it doesn't need an extra snapshot.
 * `purge_trashed_service`, by contrast, IS the irreversible step.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'deploy_service', 'rename_service', 'update_service_yaml',
  'purge_trashed_service',
  'remove_proxy_route', 'restore_backup',
  'update_config', 'exec_command',
  'set_boot_next_usb',
  'factory_reset',
]);

/**
 * Wrap an MCP tool handler in the safety layer:
 *   - read-only tools pass through unchanged.
 *   - mutating tools first call `guardMutation` (blocks when
 *     `config.mcp.allowMutations` is false).
 *   - `exec_command` additionally goes through `guardExec` (refuses
 *     dangerous shell patterns unless `allowDangerousExec` is set).
 *   - destructive tools trigger a labelled `createSystemBackup` so the
 *     operator always has a one-click rewind point.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = any;

/**
 * `destroy`-tier tools (delete/purge/restore/factory_reset/set_boot_next_usb)
 * are the ones a token caller may *propose* but not *execute* without a human
 * confirm (#1766). Derived from TOOL_SCOPES so the gate predicate stays in
 * lockstep with the scope map — adding a tool at the `destroy` tier
 * automatically routes it through the approval gate.
 */
function isDestroyTierTool(toolName: string): boolean {
  return TOOL_SCOPES[toolName] === 'destroy';
}

/**
 * A destroy-tier approval's `service` anchor for the operator's Approvals UI
 * (#2234). Most destructive tools name a target in `args.name` (delete_service,
 * delete_health_check) or `args.service` — use it when it's a single safe path
 * segment so the request reads e.g. "delete_service: honcho". Otherwise fall
 * back to a neutral "mcp" bucket (the approvals store re-validates either way).
 */
const APPROVAL_SERVICE_RE = /^[a-zA-Z0-9_.-]+$/;
function coerceApprovalService(args: Record<string, unknown>): string {
  const candidate = args.name ?? args.service;
  if (
    typeof candidate === 'string' &&
    candidate !== '.' &&
    candidate !== '..' &&
    APPROVAL_SERVICE_RE.test(candidate)
  ) {
    return candidate;
  }
  return 'mcp';
}

/**
 * Run the snapshot → real handler → audit/notify tail for one tool call.
 * This is the part of the safety flow that actually executes the mutation,
 * factored out so it can run either inline OR deferred behind a human
 * approval (#1766) without duplicating the snapshot/audit/notify logic.
 */
function runToolWithSideEffects(
  toolName: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...handlerArgs: any[]) => Promise<ToolResult>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlerArgs: any[],
  auth?: McpAuthContext,
): Promise<ToolResult> {
  return (async () => {
    const start = Date.now();
    let outcome: 'ok' | 'error' | 'blocked' = 'ok';
    let errorMessage: string | undefined;
    try {
      if (DESTRUCTIVE_TOOLS.has(toolName)) {
        // Best-effort: don't block the mutation if the snapshot fails.
        await snapshotBeforeMutation(toolName, args);
      }
      const result = await handler(...handlerArgs);
      // Result is `isError: true` when a tool reports a logical error.
      if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
        outcome = 'error';
        errorMessage = (result as { content?: { text?: string }[] }).content?.[0]?.text;
      }
      return result;
    } catch (e) {
      outcome = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const ts = new Date().toISOString();
      // Audit fire-and-forget — never block the tool response on the log
      // write. Tracked separately by mcp:audit logger.
      void recordAudit({
        ts,
        tool: toolName,
        caller: auth?.user,
        outcome,
        durationMs: Date.now() - start,
        args,
        errorMessage,
      });
      // Email the operator on every successful destructive call so a stolen
      // token / runaway agent shows up in their inbox right away. Skip
      // failures and `blocked` (the safety layer already handled those).
      // No-op when SMTP isn't configured.
      if (DESTRUCTIVE_TOOLS.has(toolName) && outcome === 'ok') {
        void notifyDestructiveOp({ tool: toolName, caller: auth?.user, args, ts }).catch(() => undefined);
      }
    }
  })();
}

function safeHandler(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...handlerArgs: any[]) => Promise<ToolResult>,
  auth?: McpAuthContext,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...handlerArgs: any[]): Promise<ToolResult> => {
    const args = (handlerArgs[0] && typeof handlerArgs[0] === 'object') ? handlerArgs[0] : {};
    // Scope check (token auth only — cookie has all scopes by design).
    const required = TOOL_SCOPES[toolName] ?? 'read';
    if (auth && !tokenHasScope(auth.scopes, required)) {
      const msg = `Token scope '${required}' required for ${toolName}; this token has [${auth.scopes.join(',')}]`;
      void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth.user, outcome: 'blocked', durationMs: 0, args, errorMessage: msg });
      return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
    }
    if (MUTATING_TOOLS.has(toolName)) {
      const blocked = await guardMutation(toolName);
      if (blocked) {
        void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth?.user, outcome: 'blocked', durationMs: 0, args, errorMessage: blocked.content[0]?.text });
        return blocked;
      }
    }
    if (toolName === 'exec_command' && typeof args.command === 'string') {
      const denied = await guardExec(args.command);
      if (denied) {
        void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth?.user, outcome: 'blocked', durationMs: 0, args, errorMessage: denied.content[0]?.text });
        return denied;
      }
    }

    // Approval gate (#1766, #2234): a TOKEN caller (the agent) may *propose* a
    // destroy-tier tool but not execute it. The proposal is parked as a
    // *persistent* approval in the shared approvals queue (lib/approvals) —
    // NOT an ephemeral in-memory pending — so it (a) shows up in the operator's
    // Approvals UI (which polls /api/approvals), (b) survives a backend restart
    // on disk, and (c) has a truthful, durable lifetime instead of vanishing
    // after ~5 min. Approving it there re-dispatches this exact tool via the
    // declared `on_approve.mcp` action; rejecting cancels it. The cookie-gated
    // approve route means the proposing token still cannot self-approve.
    // Cookie callers (no `auth`) bypass the gate and execute inline, same as
    // before: the human IS the operator. The gate lands here, AFTER the scope +
    // mutation/exec guards (so the agent still learns immediately if the call
    // would be refused) but BEFORE the snapshot/handler.
    if (auth && isDestroyTierTool(toolName)) {
      // Derive a service anchor from the tool args when it names one, else a
      // neutral "mcp" bucket. `submitApproval` re-validates it as a safe path
      // segment; fall back to "mcp" if the arg is not a usable service name.
      const service = coerceApprovalService(args);
      const request = await submitApproval({
        service,
        title: `${toolName}${service !== 'mcp' ? `: ${service}` : ''}`,
        description: `An MCP agent (${auth.user}) proposed the destructive tool "${toolName}". It runs only after you approve; the agent cannot approve its own request.`,
        payload: { toolName, args, caller: auth.user },
        on_approve: { mcp: { toolName, args } },
      });
      void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth.user, outcome: 'blocked', durationMs: 0, args, errorMessage: `pending human approval (${request.id})` });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'pending_approval',
            approvalId: request.id,
            toolName,
            args,
            message: `Destructive tool "${toolName}" requires human approval before it runs. A ServiceBay admin must approve request ${request.id} from the dashboard (Settings → Access → Approvals). This token cannot self-approve. The request is durable — it persists until an admin approves or rejects it.`,
          }, null, 2),
        }],
      };
    }

    return runToolWithSideEffects(toolName, args, handler, handlerArgs, auth);
  };
}

export function createMcpServer(opts?: { auth?: McpAuthContext }) {
  const baseServer = new McpServer(
    {
      name: 'servicebay',
      version: '1.0.0',
    },
    {
      instructions: [
        'ServiceBay manages a node (host) running self-hosted apps. The naming model is:',
        'node → service → container. A *service* is a systemd unit (e.g. `media`). Each',
        'service runs one or more *containers* named `<service>-<app>` (e.g. `media-jellyfin`,',
        '`media-audiobookshelf`). An app and its service often share a name when the service',
        'runs a single container, but a multi-app service (like `media`) does NOT — the app is',
        'a container inside it.',
        '',
        "To find an app's logs, resolve the names yourself instead of asking the user:",
        '1. `list_services` — find the owning service and its `associatedContainerIds`.',
        '2. `list_containers` — find the `<service>-<app>` container name (e.g. `media-jellyfin`).',
        '3. `get_container_logs(id)` — fetch that container\'s logs.',
        'For whole-unit (systemd) logs use `get_service_logs(name)` instead of per-container logs.',
        '',
        'Always resolve service/container names and ids from `list_services` / `list_containers`',
        'rather than asking the user for them. Use `diagnose`, `get_health_checks`, and',
        '`get_service_files` when you need more depth on a service.',
      ].join('\n'),
    },
  );
  // Wrap every tool registration so the safety layer applies uniformly.
  // Read-only tools pass through unchanged; mutating tools land in the
  // gates defined above. The auth context is closed over per-server so
  // each request gets its own scope set.
  const server = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, desc: string, schema: any, handler: (...args: any[]) => Promise<ToolResult>) =>
      baseServer.tool(name, desc, schema, safeHandler(name, handler, opts?.auth)),
    connect: baseServer.connect.bind(baseServer),
    close: baseServer.close.bind(baseServer),
  };

  // --- List Nodes ---
  server.tool('list_nodes', 'List all registered nodes with connection status and resources', {}, async () => {
    const snapshot = getStoreSnapshot();
    const nodes = await listNodes();

    const result = nodes.map(n => {
      const nodeTwin = snapshot.nodes[n.Name];
      return {
        name: n.Name,
        uri: n.URI,
        default: n.Default,
        connected: nodeTwin?.connected ?? false,
        initialSyncComplete: nodeTwin?.initialSyncComplete ?? false,
        resources: nodeTwin?.resources ?? null,
      };
    });

    return textResult(result);
  });

  // --- List Services ---
  server.tool('list_services', 'List logical services (systemd units) on a node with status, ports, volumes. A service may bundle multiple containers (see `associatedContainerIds`); to target a specific app, resolve its `<service>-<app>` container via list_containers.', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getServices(nodeName));
  });

  // --- List Containers ---
  server.tool('list_containers', 'List running containers with image, state, ports. Container names follow `<service>-<app>` (e.g. `media-jellyfin`); use the resolved name with get_container_logs.', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getContainers(nodeName));
  });

  // --- Get Service Logs ---
  server.tool(
    'get_service_logs',
    'Fetch systemd journal logs for a whole service (the systemd unit). For a single app inside a multi-container service, use get_container_logs with the `<service>-<app>` name instead. Use `since` (Unix seconds) on subsequent calls to get only newer lines for a debug-loop pattern.',
    {
      name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid service name').describe('Service name'),
      node: nodeParam,
      lines: z.number().int().min(1).max(10000).optional().describe('Number of lines from the end (default 200)'),
      since: z.number().int().optional().describe('Unix seconds — return only entries newer than this'),
    },
    async ({ name, node, lines, since }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const unit = name.match(/\.(service|scope|socket|timer)$/) ? name : `${name}.service`;
        const args = [`--user`, `-u`, unit, `-n`, String(lines ?? 200), '--no-pager', '--output', 'short-iso'];
        if (since) args.push('--since', `@${since}`);
        const result = await agent.sendCommand('exec', { command: `journalctl ${args.join(' ')} 2>&1` });
        return textResult({
          // Strip credentials before handing journalctl output back to
          // the MCP client (#321) — service journals catch any
          // post-deploy line that prints rendered passwords plus
          // anything the service itself dumps at startup.
          stdout: redactLogText(result.stdout ?? ''),
          exitCode: result.code,
          fetchedAt: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        return errorResult(`Error fetching service logs: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Get Container Logs ---
  server.tool(
    'get_container_logs',
    'Fetch container stdout/stderr logs. `id` is the `<service>-<app>` container name (e.g. `media-jellyfin`); resolve it via list_containers. Use `since` (Unix seconds) on subsequent calls to get only newer lines for a debug-loop pattern.',
    {
      id: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid container id').describe('Container ID or name'),
      node: nodeParam,
      tail: z.number().int().min(1).max(10000).optional().describe('Number of lines from the end (default 200)'),
      since: z.number().int().optional().describe('Unix seconds — return only lines newer than this'),
    },
    async ({ id, node, tail, since }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const args = [`--tail ${tail ?? 200}`, '--timestamps'];
        if (since) args.push(`--since ${since}`);
        const result = await agent.sendCommand('exec', { command: `podman logs ${args.join(' ')} ${id} 2>&1` });
        return textResult({
          // Same redaction as get_service_logs — see #321.
          stdout: redactLogText(result.stdout ?? ''),
          exitCode: result.code,
          fetchedAt: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        return errorResult(`Error fetching container logs: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Start Service ---
  server.tool(
    'start_service',
    'Start a stopped service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.startService(nodeName, name);
      const status = await ServiceManager.getServiceStatus(nodeName, name);
      return textResult(status);
    },
  );

  // --- Stop Service ---
  server.tool(
    'stop_service',
    'Stop a running service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.stopService(nodeName, name);
      const status = await ServiceManager.getServiceStatus(nodeName, name);
      return textResult(status);
    },
  );

  // --- Restart Service ---
  server.tool(
    'restart_service',
    'Restart a service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.restartService(nodeName, name);
      const status = await ServiceManager.getServiceStatus(nodeName, name);
      return textResult(status);
    },
  );

  // --- Release channel (#1459): lets the autoloop flip the box to :dev to
  // verify a just-merged batch, then back to :latest, without a human. ---
  server.tool(
    'get_channel',
    'Get the ServiceBay release channel the box is currently running (latest | dev | test).',
    {},
    async () => {
      const channel = await getServicebayChannel();
      return textResult({ channel });
    },
  );

  server.tool(
    'set_channel',
    'Switch the ServiceBay release channel and restart onto it. latest = last release; dev = latest non-release main commit (use to verify a just-merged change on the box, then set back to latest); test = test image. Pull + restart run in the background, so this returns before the box restarts (~1-2 min) and the MCP connection drops during the restart — reconnect and poll get_channel after.',
    { channel: z.enum(['latest', 'dev', 'test']) },
    async ({ channel }) => {
      await setServicebayChannel(channel);
      return textResult({ ok: true, channel, note: 'Pull + restart triggered in the background. The box will be on the new channel after it restarts; this MCP connection drops during the restart — reconnect, then poll get_channel.' });
    },
  );

  // --- Get Service Files ---
  server.tool(
    'get_service_files',
    'Get the on-disk files for a service. Returns `kubeContent` = the systemd Quadlet unit, `yamlContent` = the Kubernetes Pod-spec `.yml` (apiVersion/kind/spec), and `quadletKind` = "kube" or "container". For a `.kube` service (quadletKind="kube"): `kubeContent` is the [Kube]/[Install] unit and `yamlContent` is the pod spec; these field names are REVERSED relative to update_service_yaml — to write back the pod spec, pass this tool\'s `yamlContent` into update_service_yaml (the Quadlet unit is regenerated on its own). For a single-container `.container` service (quadletKind="container", e.g. ollama after the GPU fixup): `kubeContent` is the whole `.container` unit ([Container] section) and `yamlContent` is empty — the unit file IS the artifact, so edit `kubeContent` and pass it straight into update_service_yaml.',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      const files = await ServiceManager.getServiceFiles(nodeName, name);
      // Rendered kube YAML inlines templated `{{X_PASSWORD}}` values.
      // Redact env entries with sensitive names before returning to the
      // MCP client (#321). The dashboard's own service-file viewer
      // doesn't go through this path; it reads from the same source
      // files but is gated by the admin session.
      return textResult(redactServiceFiles(files));
    },
  );

  // --- Deploy Service ---
  server.tool(
    'deploy_service',
    'Deploy a new service or update an existing one from kube YAML. Pass extraFiles to seed companion config (e.g. authelia/configuration.yml).',
    {
      name: z.string().describe('Service name'),
      kubeContent: z.string().describe('Kubernetes/Podman kube YAML content'),
      yamlContent: z.string().optional().describe('Companion compose/config YAML content'),
      yamlFileName: z.string().optional().describe('Filename for the companion YAML'),
      extraFiles: z
        .array(
          z.object({
            path: z.string().describe('Absolute path on the node (e.g. /mnt/data/stacks/auth/authelia-config/configuration.yml)'),
            content: z.string().describe('File content (already mustache-rendered)'),
          }),
        )
        .optional()
        .describe('Additional config files to write before the unit starts. Failures are fatal — the deploy aborts so the operator knows the service would have started misconfigured.'),
      node: nodeParam,
    },
    async ({ name, kubeContent, yamlFileName, extraFiles, node }) => {
      const nodeName = await resolveNode(node);
      // `kubeContent` here is the Pod YAML (Kubernetes manifest). We generate
      // the systemd .kube unit internally — same pattern as the install runner
      // (src/lib/install/runner.ts:275-276). The parameter name is historical;
      // the MCP description says "kube YAML content" meaning the Pod YAML.
      // The schema still accepts `yamlContent` for backwards-compat with
      // MCP clients that pass it; the handler ignores it because the
      // companion YAML is derived from `kubeContent` + extraFiles, not a
      // separate top-level field. Drop the schema entry in a future API
      // surface review.
      const resolvedYamlFileName = yamlFileName ?? `${name}.yml`;
      const generatedKubeUnit = `[Kube]\nYaml=${resolvedYamlFileName}\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;
      await ServiceManager.deployKubeService(
        nodeName,
        name,
        generatedKubeUnit,
        kubeContent,
        resolvedYamlFileName,
        extraFiles,
      );
      return textResult(`Service "${name}" deployed successfully${extraFiles?.length ? ` (${extraFiles.length} extra file${extraFiles.length === 1 ? '' : 's'} written)` : ''}`);
    },
  );

  // --- Delete Service (soft) ---
  server.tool(
    'delete_service',
    'Soft-delete a service: stops the unit and moves its files to the trash bucket. Restorable via restore_trashed_service for 7 days; then auto-purged. Use purge_trashed_service to delete immediately.',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.deleteService(nodeName, name);
      return textResult(`Service "${name}" moved to trash. Use list_trashed_services / restore_trashed_service to recover.`);
    },
  );

  // --- List Trashed Services ---
  server.tool(
    'list_trashed_services',
    'List soft-deleted services available to restore. Each entry has an `id` you can pass to restore_trashed_service or purge_trashed_service.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      const items = await ServiceManager.listTrashedServices(nodeName);
      return textResult(items);
    },
  );

  // --- Restore From Trash ---
  server.tool(
    'restore_trashed_service',
    'Restore a soft-deleted service from trash. Use list_trashed_services to find the id.',
    { id: z.string().describe('Trash entry id'), node: nodeParam },
    async ({ id, node }) => {
      const nodeName = await resolveNode(node);
      const result = await ServiceManager.restoreTrashedService(nodeName, id);
      return textResult(`Service "${result.service}" restored from trash on ${nodeName}.`);
    },
  );

  // --- Purge Trash (permanent delete) ---
  server.tool(
    'purge_trashed_service',
    'Permanently delete a trash entry. Use list_trashed_services to find the id. Counts as a destructive op (snapshotted).',
    { id: z.string().describe('Trash entry id'), node: nodeParam },
    async ({ id, node }) => {
      const nodeName = await resolveNode(node);
      const result = await ServiceManager.purgeTrash(nodeName, { trashId: id });
      return textResult(`Purged ${result.purged.length} trash entr${result.purged.length === 1 ? 'y' : 'ies'} on ${nodeName}.`);
    },
  );

  // --- Rename Service ---
  server.tool(
    'rename_service',
    'Rename a service',
    {
      oldName: z.string().describe('Current service name'),
      newName: z.string().describe('New service name'),
      node: nodeParam,
    },
    async ({ oldName, newName, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.renameService(nodeName, oldName, newName);
      return textResult(`Service renamed from "${oldName}" to "${newName}"`);
    },
  );

  // --- Get System Info ---
  server.tool('get_system_info', 'Get CPU, memory, disk, and uptime info for a node', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    const nodeTwin = getNodeTwin(nodeName);

    if (!nodeTwin) {
      return errorResult(`Node "${nodeName}" not found`);
    }

    return textResult({
      connected: nodeTwin.connected,
      resources: nodeTwin.resources,
      health: nodeTwin.health,
      nodeIPs: nodeTwin.nodeIPs,
    });
  });

  // --- List Templates ---
  server.tool('list_templates', 'List available deployment templates', {}, async () => {
    const templates = await getTemplates();
    return textResult(templates);
  });

  // --- Get Template Readme ---
  server.tool(
    'get_template_readme',
    'Get the README/documentation for a deployment template',
    {
      name: z.string().describe('Template name'),
      type: z.enum(['template', 'stack']).optional().describe('Template type (default: template)'),
      source: z.string().optional().describe('Registry source'),
    },
    async ({ name, type, source }) => {
      const readme = await getReadme(name, type ?? 'template', source);
      if (!readme) return errorResult(`No README found for template "${name}"`);
      return textResult(readme);
    },
  );

  // --- Get Template YAML ---
  server.tool(
    'get_template_yaml',
    'Get the kube YAML content for a deployment template',
    {
      name: z.string().describe('Template name'),
      source: z.string().optional().describe('Registry source'),
    },
    async ({ name, source }) => {
      const yaml = await getTemplateYaml(name, source);
      if (!yaml) return errorResult(`No YAML found for template "${name}"`);
      return textResult(yaml);
    },
  );

  // --- Get Template Variables ---
  server.tool(
    'get_template_variables',
    'Get configurable variables for a deployment template',
    {
      name: z.string().describe('Template name'),
      source: z.string().optional().describe('Registry source'),
    },
    async ({ name, source }) => {
      const vars = await getTemplateVariables(name, source);
      if (!vars) return errorResult(`No variables found for template "${name}"`);
      return textResult(vars);
    },
  );

  // --- Install Template (#2141) ---
  // Wraps the wizard's server-side flow — assembleManifest → createJob →
  // startJob — so an MCP client gets the FULL template deploy (variable
  // assembly, global injection, secret gen, subdomain→NPM proxy host, Authelia
  // wiring, dependency ordering, migrations), not the raw-YAML deploy_service
  // shortcut. Returns a jobId; poll get_install_progress for phase + logs +
  // deployed names. Mirrors POST /api/install/assemble + /api/install/start
  // by calling the same lib functions directly (no HTTP hop).
  server.tool(
    'install_template',
    'Install one or more templates the way the setup wizard does: assembles the manifest (variable defaults, global injection, secret generation), then starts the deploy job (subdomain→NPM proxy host, Authelia wiring, dependency ordering, migrations all included). Returns a jobId — poll get_install_progress to watch phase/logs and read the deployed service names. Use this instead of deploy_service when you want the full template flow (SSO/cert/proxy wiring), not a raw-YAML deploy.',
    {
      names: z.array(z.string().min(1)).min(1).describe('Template/stack name(s) to install, e.g. ["vaultwarden"].'),
      templateSource: z.string().optional().describe('Where to resolve the templates from: "Built-in", "Local", a registry name, or omit to walk all sources.'),
      variables: z.record(z.string(), z.string()).optional().describe('Variable overrides (name→value); win over template defaults. e.g. { SUBDOMAIN_TOR: "tor" }.'),
      wipeMode: z.enum(['install', 'wipe-config', 'wipe-all']).optional().describe('install (default, keep data) | wipe-config | wipe-all (destructive).'),
      node: nodeParam,
    },
    async ({ names, templateSource, variables, wipeMode, node }) => {
      try {
        const active = await getCurrentJob();
        if (active) {
          return errorResult(`An install job is already in progress (jobId=${active.id}, phase=${active.phase}). Wait for it to finish (poll get_install_progress) or abort it before starting another.`);
        }
        const assembled = await assembleManifest({
          items: names.map((name: string) => ({ name, checked: true })),
          prefilled: variables,
          templateSource,
        });
        const input: JobInput = {
          items: assembled.items,
          variables: assembled.variables,
          templateSource: templateSource ?? 'Built-in',
          host: 'localhost',
          wipeMode: (wipeMode as WipeMode | undefined) ?? 'install',
          ...(node ? { node } : {}),
        };
        const withDefaults = await applyVariableDefaults(input, templateSource);
        const job = await createJob({ source: 'mcp', input: withDefaults });
        startJob(job.id);
        return textResult({
          jobId: job.id,
          phase: job.phase,
          note: `Install started. Poll get_install_progress(jobId="${job.id}") for phase, logs, and deployed service names.`,
        });
      } catch (e) {
        if (e instanceof InstallInProgressError) {
          return errorResult(`An install job is already in progress (jobId=${e.existingJobId}). Poll get_install_progress or abort it first.`);
        }
        return errorResult(`Error starting install: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // --- Get Install Progress (#2141) ---
  server.tool(
    'get_install_progress',
    'Poll an install job (started via install_template) by jobId. Returns phase (running | needs_credentials | done | error | aborted | crashed), whether it is still active, the deployed service names so far, any error, and new log lines. Pass logsSince (the previous call\'s logsOffset) to fetch only newer lines.',
    {
      jobId: z.string().min(1).describe('The jobId returned by install_template.'),
      logsSince: z.number().int().min(0).optional().describe('Byte offset from a previous call (logsOffset) — returns only log lines added since then.'),
    },
    async ({ jobId, logsSince }) => {
      const job = await getJob(jobId);
      if (!job) return errorResult(`No install job found with id "${jobId}".`);
      const { content, nextOffset } = await readLog(jobId, logsSince);
      const active = job.phase === 'running' || job.phase === 'needs_credentials';
      return textResult({
        jobId: job.id,
        phase: job.phase,
        active,
        currentItem: job.progress.currentItem,
        deployedNames: job.progress.deployedNames,
        totalCount: job.progress.totalCount,
        needsCredentials: job.phase === 'needs_credentials',
        error: job.error,
        logs: redactLogText(content),
        logsOffset: nextOffset,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        endedAt: job.endedAt,
      });
    },
  );

  // --- List Assists (#2146) ---
  // Discover task-help entries (guides, ordered recipes, checklists, footguns,
  // snippets) from the extensible catalog. Pass a free-text `query` describing
  // the task to rank matches; each entry's `whenToUse` lets you self-select the
  // right one, then fetch its full content with `get_assist`.
  server.tool(
    'list_assists',
    'Discover task-help entries (guides, recipes, ADR-style architecture recommendations, checklists, footguns, snippets) from the ServiceBay assist catalog. Pass a free-text `query` describing your task to rank relevant entries; read the returned `whenToUse` to pick one, then fetch it with get_assist. Use this FIRST when authoring/deploying a new service, when you need an overview of ServiceBay or Solaris, or when unsure how to perform a ServiceBay task — so you don\'t re-derive knowledge that already exists.',
    {
      query: z.string().optional().describe('Free-text task description to rank matching entries (e.g. "deploy a new service behind SSO"). Omit to list everything.'),
      kind: z.enum(ASSIST_KINDS).optional().describe('Restrict to one kind: guide | recipe | adr | template | checklist | footgun | snippet.'),
    },
    async ({ query, kind }) => {
      const assists = await listAssists({ query, kind });
      return textResult(assists);
    },
  );

  // --- Get Assist (#2146) ---
  server.tool(
    'get_assist',
    'Fetch the full content (markdown: frontmatter + body) of one assist catalog entry by id. Use list_assists first to find the id.',
    {
      id: z.string().describe('Assist id (the entry id returned by list_assists).'),
    },
    async ({ id }) => {
      const body = await getAssist(id);
      if (!body) return errorResult(`No assist found with id "${id}". Use list_assists to see available entries.`);
      return textResult(body);
    },
  );

  // --- Get Network Graph ---
  server.tool('get_network_graph', 'Get network topology: nodes, edges, port mappings', {}, async () => {
    const snapshot = getStoreSnapshot();
    const nodes = await listNodes();

    const graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
    const edges: Array<{ source: string; target: string; label?: string }> = [];

    for (const n of nodes) {
      const nodeTwin = snapshot.nodes[n.Name];
      graphNodes.push({
        id: `node:${n.Name}`,
        type: 'node',
        data: {
          name: n.Name,
          uri: n.URI,
          connected: nodeTwin?.connected ?? false,
          containerCount: nodeTwin?.containers?.length ?? 0,
          serviceCount: nodeTwin?.services?.length ?? 0,
        },
      });

      if (nodeTwin?.containers) {
        for (const c of nodeTwin.containers) {
          const containerId = `container:${n.Name}:${c.id || c.names?.[0]}`;
          graphNodes.push({
            id: containerId,
            type: 'container',
            data: {
              name: c.names?.[0] ?? c.id,
              image: c.image,
              state: c.state,
              ports: c.ports,
            },
          });
          edges.push({ source: `node:${n.Name}`, target: containerId });
        }
      }
    }

    if (snapshot.gateway?.publicIp) {
      graphNodes.push({
        id: 'gateway',
        type: 'gateway',
        data: {
          publicIp: snapshot.gateway.publicIp,
          provider: snapshot.gateway.provider,
          portMappings: snapshot.gateway.portMappings,
        },
      });
      for (const n of nodes) {
        edges.push({ source: 'gateway', target: `node:${n.Name}` });
      }
    }

    return textResult({ nodes: graphNodes, edges });
  });

  // --- Get Health Checks ---
  server.tool('get_health_checks', 'List all health checks with their latest results', {}, async () => {
    const checks = HealthStore.getChecks();
    const result = checks.map(check => ({
      ...check,
      lastResult: HealthStore.getLastResult(check.id),
    }));
    return textResult(result);
  });

  // --- Get Gateway Status ---
  server.tool('get_gateway_status', 'Get gateway info: public IP, port mappings, uptime', {}, async () => {
    return textResult(getStoreSnapshot().gateway);
  });

  // --- Get Proxy Routes ---
  // #2140 — Returns the aggregated proxy state AND, best-effort, NPM's LIVE
  // per-host status (enabled + nginx_online/nginx_err from NPM's DB). A host
  // whose conf nginx reverted shows nginx_online=false + the [emerg] reason,
  // so a broken route is visible from the MCP instead of only via NPM's sqlite.
  server.tool('get_proxy_routes', 'Get reverse proxy routes configuration, including each NPM host\'s live nginx status (nginx_online / nginx_err) when reachable — a broken conf shows nginx_online=false with the error.', { node: nodeParam }, async ({ node }) => {
    const proxyState = getStoreSnapshot().proxyState;
    let liveHosts: unknown = null;
    let liveError: string | undefined;
    try {
      const qs = node ? `?node=${encodeURIComponent(node)}` : '';
      const res = await loopbackFetch(`/api/system/nginx/proxy-hosts${qs}`, { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) liveHosts = (data as { hosts?: unknown }).hosts ?? [];
      else liveError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    }
    return textResult({ proxyState, liveHosts, ...(liveError ? { liveStatusError: liveError } : {}) });
  });

  // --- Exec Command ---
  server.tool(
    'exec_command',
    'Execute a shell command on a node',
    {
      command: z.string().describe('Shell command to execute'),
      node: nodeParam,
    },
    async ({ command, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const result = await agent.sendCommand('exec', { command });
        return textResult(result);
      } catch (err) {
        return errorResult(`Error executing command: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Verify Node Connection ---
  server.tool(
    'verify_node_connection',
    'Test SSH connectivity to a node',
    { name: z.string().describe('Node name') },
    async ({ name }) => {
      const result = await verifyNodeConnection(name);
      return textResult(result);
    },
  );

  // --- Get Podman Logs ---
  server.tool(
    'get_podman_logs',
    'Get raw podman daemon/system logs',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      const logs = await ServiceManager.getPodmanLogs(nodeName);
      return textResult(logs);
    },
  );

  // --- List System Services ---
  server.tool(
    'list_system_services',
    'List all systemd services on a node (not just managed ones)',
    { node: nodeParam },
    async ({ node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      const services = await getAllSystemServices(connection);
      return textResult(services);
    },
  );

  // --- Refresh Agent ---
  server.tool(
    'refresh_agent',
    'Force an agent to re-sync its state from the node',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        await agent.sendCommand('refresh');
        return textResult(`Agent for "${nodeName}" refreshed successfully`);
      } catch (err) {
        return errorResult(`Error refreshing agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Self-Diagnose (mirrors POST /api/system/diagnose) ---
  server.tool(
    'diagnose',
    'Run a battery of self-test probes on a node — agent reachable, podman, pods, failed units, USB sticks, /mnt/data, first-boot units. Returns a structured list of probes with status (ok/warn/fail/info) and remediation hints. Useful for "why isn\'t this working?" troubleshooting.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        // Direct call into the lib orchestrator (#600). Replaces the
        // earlier faux-fetch through the route file that violated the
        // lib-no-import-app invariant.
        const { runDiagnose } = await import('@/lib/diagnose/runDiagnose');
        const data = await runDiagnose(nodeName);
        return textResult(data);
      } catch (err) {
        return errorResult(`Error running diagnostics: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Update Service YAML (edit then redeploy) ---
  server.tool(
    'update_service_yaml',
    'Replace a service\'s on-disk definition and redeploy it. Use `get_service_files` first, modify, then call this. For a `.kube` service (quadletKind="kube"): the content this tool wants (in `kubeContent`/`podSpecContent`) is the POD SPEC — i.e. the `yamlContent` returned by get_service_files (apiVersion/kind/spec), NOT its `kubeContent` (the `.kube` Quadlet unit, regenerated automatically). For a single-container `.container` service (quadletKind="container", e.g. ollama): there is no pod spec — pass the edited `.container` unit body (the `kubeContent` from get_service_files, with a [Container] section) and it is written straight back. Either way the file is written and `systemctl --user daemon-reload` + restart is triggered.',
    {
      name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid service name').describe('Service name'),
      kubeContent: z.string().min(1).optional().describe('The Pod-spec `.yml` content (the `yamlContent` from get_service_files, apiVersion/kind/spec) — NOT the `.kube` Quadlet unit. Historical name; prefer `podSpecContent`. One of kubeContent / podSpecContent is required.'),
      podSpecContent: z.string().min(1).optional().describe('Alias for kubeContent — the Pod-spec `.yml` content (apiVersion/kind/spec). Clearer name for the same field; takes precedence if both are given.'),
      yamlContent: z.string().optional().describe('Optional companion compose/config YAML'),
      yamlFileName: z.string().optional().describe('Filename for companion YAML (default: <name>.yaml)'),
      node: nodeParam,
    },
    async ({ name, kubeContent, podSpecContent, yamlFileName, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const podSpec = podSpecContent ?? kubeContent;
        if (!podSpec) {
          return errorResult('Error updating service: provide the Pod-spec `.yml` content via `podSpecContent` (or `kubeContent`).');
        }
        // #1778: a single-container `.container` Quadlet (the ollama GPU
        // fixup) has no separate pod spec — the unit file IS the deploy
        // artifact, so the read/update contract differs: the caller edits
        // the `.container` unit body (the `kubeContent` from
        // get_service_files) and we write it straight back. A `.container`
        // body is the only legitimate reason to pass a `[Container]`
        // section, so only then do we look the service up (avoids a per-call
        // agent round-trip on the common `.kube` pod-spec path); the lookup
        // confirms the on-disk unit really is a `.container` before writing.
        if (/^\s*\[Container\]/m.test(podSpec)) {
          const existing = await ServiceManager.getServiceFiles(nodeName, name).catch(() => null);
          if (existing?.quadletKind === 'container') {
            await ServiceManager.deployContainerQuadlet(nodeName, name, podSpec);
            return textResult(`Service "${name}" (.container Quadlet) updated and redeployed`);
          }
          // Not a .container service — fall through to the footgun guard,
          // which correctly rejects a Quadlet unit passed where a pod spec
          // is expected.
        }
        // Field-name footgun guard: get_service_files returns the `.kube`
        // Quadlet unit under `kubeContent`. If a caller round-trips that field
        // verbatim into here, the `[Kube]`/`[Unit]` systemd unit would be
        // written into the Pod-spec `.yml` and clobber the manifest. Reject it
        // with a pointer to the right field rather than silently swapping the
        // on-disk files (memory: reference_box_credential_rekey_mechanics).
        if (/^\s*\[(Unit|Kube|Install|Container|Service)\]/m.test(podSpec)) {
          return errorResult(
            'Error updating service: the content looks like a systemd `.kube` Quadlet unit (has a [Kube]/[Unit] section), not a Pod-spec `.yml`. ' +
            'update_service_yaml expects the POD SPEC — that is the `yamlContent` field from get_service_files (apiVersion/kind/spec), NOT its `kubeContent`. ' +
            'The Quadlet unit is regenerated automatically; pass the pod spec instead.',
          );
        }
        const resolvedYamlFileName = yamlFileName ?? `${name}.yml`;
        const generatedKubeUnit = `[Kube]\nYaml=${resolvedYamlFileName}\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;
        await ServiceManager.deployKubeService(
          nodeName,
          name,
          generatedKubeUnit,
          podSpec,
          resolvedYamlFileName,
        );
        return textResult(`Service "${name}" updated and redeployed`);
      } catch (err) {
        return errorResult(`Error updating service: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Reverse-proxy routes (declarative; updates config.reverseProxy.hosts) ---
  // Note: writing to config records the desired route. Pushing to NPM (Nginx
  // Proxy Manager) still happens via the UI / POST /api/system/nginx/proxy-hosts
  // because that requires NPM admin credentials.

  server.tool(
    'add_proxy_route',
    'Add or update a reverse-proxy route entry in ServiceBay config. Domain is the public hostname; forwardPort is the internal port. Updates `config.reverseProxy.hosts`. Pushing to NPM still requires the user to click "sync" in Settings.',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Public domain, e.g. "vault.example.com"'),
      forwardPort: z.number().int().min(1).max(65535).describe('Internal port the upstream service listens on'),
      service: z.string().optional().describe('Logical service name (default: first label of domain)'),
    },
    async ({ domain, forwardPort, service }) => {
      const config = await getConfig();
      const hosts = [...(config.reverseProxy?.hosts ?? [])];
      const idx = hosts.findIndex(h => h.domain === domain);
      const entry: ProxyHostEntry = {
        domain,
        service: service ?? domain.split('.')[0],
        forwardPort,
        created: idx >= 0 ? hosts[idx].created : false,
        sslConfigured: idx >= 0 ? hosts[idx].sslConfigured : false,
        createdAt: idx >= 0 ? hosts[idx].createdAt : new Date().toISOString(),
      };
      if (idx >= 0) hosts[idx] = entry;
      else hosts.push(entry);
      await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts } });
      return textResult({
        action: idx >= 0 ? 'updated' : 'added',
        entry,
        note: 'Config updated. Push to NPM via Settings → Reverse Proxy → Sync.',
      });
    },
  );

  // #2140 — Create a COMPLETE NPM proxy host in one MCP call, reusing the
  // install-runner's proxy-host wiring (POST /api/system/nginx/proxy-hosts):
  // exposure tier (cert + LAN allow-list), Authelia forward-auth, optional
  // custom advanced_config / forwardHost / ssl, best-effort LE cert. Unlike
  // add_proxy_route (which only records a config entry for a later manual
  // sync), this pushes to NPM immediately and returns the per-host result
  // (created, certIssued/certError, lanRestricted). The forward-auth snippet
  // is expanded server-side by the route with the correct acme-bypass handling
  // per exposure (#2143 — no duplicate acme location on LE hosts).
  server.tool(
    'create_proxy_route',
    'Create a complete NPM reverse-proxy host in one call: pick an exposure tier (public|internal|lan), optionally gate it behind Authelia forward-auth SSO, and (for public/internal) request a Let\'s Encrypt cert — matching what a template install produces. Pushes to NPM immediately (unlike add_proxy_route, which only records a config entry). Returns the create + cert outcome per host; check get_proxy_routes for live nginx_online status afterward.',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Full public hostname, e.g. "tor.dopp.cloud".'),
      forwardPort: z.number().int().min(1).max(65535).describe('Internal port the upstream service listens on.'),
      forwardHost: z.string().optional().describe('Upstream host/IP (default: the node\'s LAN IP — correct for services on the box).'),
      exposure: z.enum(['public', 'internal', 'lan']).optional().default('public').describe('public = LE cert + open; internal = LE cert + LAN-only allow-list; lan = no cert, LAN-only (forward-auth does NOT work on lan — Authelia needs https). Default: public.'),
      forwardAuth: z.boolean().optional().default(false).describe('Gate the route behind Authelia forward-auth SSO. Requires exposure public|internal (needs https). Expands the same nginx snippet a template install uses so Remote-User reaches the upstream.'),
      sslForced: z.boolean().optional().describe('Force HTTPS redirect (default true for public/internal once a cert binds).'),
      websocket: z.boolean().optional().describe('Enable WebSocket upgrade on the host.'),
      advancedConfig: z.string().optional().describe('Custom nginx directives to inject into the server block (appended after any forward-auth snippet).'),
      authSkipPaths: z.array(z.string().startsWith('/')).optional().describe('#2210 — path prefixes that skip forward-auth while the rest of the host stays gated, e.g. ["/.well-known/", "/static/"]. Each becomes an `auth_request off` location that still proxies upstream (TWA assetlinks, ACME, PWA assets). Only meaningful with forwardAuth=true.'),
      service: z.string().optional().describe('Logical service name (default: first label of the domain).'),
      node: nodeParam,
    },
    async ({ domain, forwardPort, forwardHost, exposure, forwardAuth, sslForced, websocket, advancedConfig, authSkipPaths, service, node }) => {
      if (forwardAuth && exposure === 'lan') {
        return errorResult('forwardAuth requires exposure "public" or "internal": Authelia forward-auth needs an https (cert-bound) host, and a "lan" host serves plain HTTP. Use exposure "internal" for a LAN-only SSO-gated service.');
      }
      // Compose the advanced_config: forward-auth sentinel first (the route
      // expands + port-substitutes it with the correct acme-bypass for the
      // exposure, #2143), then any custom directives the caller supplied.
      let composedAdvanced: string | undefined;
      if (forwardAuth) {
        composedAdvanced = advancedConfig
          ? `${AUTHELIA_FORWARD_AUTH_SENTINEL}\n${advancedConfig}`
          : AUTHELIA_FORWARD_AUTH_SENTINEL;
      } else if (advancedConfig) {
        composedAdvanced = advancedConfig;
      }
      const host = {
        domain,
        forwardPort,
        ...(forwardHost ? { forwardHost } : {}),
        service: service ?? domain.split('.')[0],
        exposure,
        proxyConfig: {
          ...(websocket !== undefined ? { allow_websocket_upgrade: websocket } : {}),
          ...(sslForced !== undefined ? { ssl_forced: sslForced } : {}),
          ...(composedAdvanced ? { advanced_config: composedAdvanced } : {}),
          ...(authSkipPaths?.length ? { authSkipPaths } : {}),
        },
      };
      try {
        const res = await loopbackFetch('/api/system/nginx/proxy-hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hosts: [host], node }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
          return errorResult(`Failed to create proxy route for ${domain}: ${msg}`);
        }
        const d = data as { created?: string[]; failed?: { domain: string; error?: string }[]; certs?: { domain: string; issued: boolean; error?: string }[]; lanRestricted?: string[] };
        const failedHere = (d.failed ?? []).find(f => f.domain === domain);
        if (failedHere) {
          return errorResult(`NPM rejected the proxy host for ${domain}: ${failedHere.error ?? 'unknown error'}`);
        }
        return textResult({
          created: (d.created ?? []).includes(domain),
          domain,
          exposure,
          forwardAuth: !!forwardAuth,
          cert: (d.certs ?? []).find(c => c.domain === domain) ?? null,
          lanRestricted: (d.lanRestricted ?? []).includes(domain),
          note: 'Route pushed to NPM. Poll get_proxy_routes to confirm nginx_online=true (a bad conf reverts silently otherwise).',
        });
      } catch (e) {
        return errorResult(`Error creating proxy route: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'remove_proxy_route',
    'Remove a reverse-proxy route entry from ServiceBay config (does not remove from NPM — do that in the UI).',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Public domain to remove'),
    },
    async ({ domain }) => {
      const config = await getConfig();
      const hosts = config.reverseProxy?.hosts ?? [];
      const filtered = hosts.filter(h => h.domain !== domain);
      if (filtered.length === hosts.length) {
        return errorResult(`No proxy route found for domain "${domain}"`);
      }
      await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts: filtered } });
      return textResult({ action: 'removed', domain });
    },
  );

  // --- Backups ---

  server.tool('list_backups', 'List recent backup runs (success / failed) with timestamps and file paths', {}, async () => {
    const history = await getBackupHistory();
    return textResult(history);
  });

  server.tool(
    'run_backup',
    'Trigger a backup run now. Returns the run record once complete. Errors if a backup is already running.',
    {},
    async () => {
      if (isBackupRunning()) {
        return errorResult('A backup is already running. Wait for it to finish before starting another.');
      }
      try {
        const result = await runBackupService();
        return textResult(result);
      } catch (err) {
        return errorResult(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'restore_backup',
    'Restore a full system backup from a backup file. This restores config, services, and data — use with care. For selective restore, use the UI.',
    {
      fileName: z.string().min(1).describe('Backup file name as returned by list_backups (e.g. "servicebay-2026-05-04.tar.gz")'),
    },
    async ({ fileName }) => {
      try {
        const entry = await restoreSystemBackup(fileName);
        return textResult({ restored: entry });
      } catch (err) {
        return errorResult(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Health checks ---

  const checkTypeSchema = z.enum([
    'http', 'ping', 'script', 'podman', 'service', 'systemd', 'fritzbox', 'node', 'agent', 'backup',
  ]);

  server.tool(
    'create_health_check',
    'Create a new health check (HTTP, ping, container, service, …). Returns the created check including generated id.',
    {
      name: z.string().min(1).describe('Display name'),
      type: checkTypeSchema.describe('Check type'),
      target: z.string().min(1).describe('URL / IP / container id / service name / script depending on type'),
      interval: z.number().int().min(10).max(86400).describe('Interval in seconds (10s–24h)'),
      enabled: z.boolean().optional().describe('Default: true'),
      nodeName: z.string().optional().describe('Node to run the check from (default: first available)'),
      httpExpectedStatus: z.number().int().optional().describe('For type=http: expected HTTP status'),
      httpBodyMatch: z.string().optional().describe('For type=http: substring or regex the response body must match'),
    },
    async ({ name, type, target, interval, enabled, nodeName, httpExpectedStatus, httpBodyMatch }) => {
      const check: CheckConfig = {
        id: randomUUID(),
        name,
        type: type as CheckType,
        target,
        interval,
        enabled: enabled ?? true,
        created_at: new Date().toISOString(),
        nodeName,
        ...(type === 'http' && (httpExpectedStatus || httpBodyMatch)
          ? {
              httpConfig: {
                expectedStatus: httpExpectedStatus,
                bodyMatch: httpBodyMatch,
                bodyMatchType: 'contains',
              },
            }
          : {}),
      };
      HealthStore.saveCheck(check);
      return textResult(check);
    },
  );

  server.tool(
    'delete_health_check',
    'Delete a health check by id (use get_health_checks to find ids).',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const before = HealthStore.getChecks().length;
      HealthStore.deleteCheck(id);
      const after = HealthStore.getChecks().length;
      if (before === after) return errorResult(`No check with id "${id}" found`);
      return textResult({ deleted: id });
    },
  );

  server.tool(
    'run_check_now',
    'Run a health check immediately and persist the result. Returns the result.',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const check = HealthStore.getChecks().find(c => c.id === id);
      if (!check) return errorResult(`No check with id "${id}" found`);
      try {
        const result = await CheckRunner.run(check);
        HealthStore.saveResult(result);
        return textResult(result);
      } catch (err) {
        return errorResult(`Check run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Config (read + selective write) ---

  // Strip secrets and compute-only fields when returning config to the LLM.
  // Anything not listed here is passed through; explicit deletes are below.
  const sanitizeConfig = (cfg: AppConfig): Partial<AppConfig> => {
    const out: AppConfig = JSON.parse(JSON.stringify(cfg));
    if (out.auth) delete out.auth.passwordHash;
    if (out.oidc) {
      out.oidc.clientSecret = out.oidc.clientSecret ? '***' : '';
    }
    if (out.notifications?.email) {
      out.notifications.email = { ...out.notifications.email, pass: out.notifications.email.pass ? '***' : '' };
    }
    return out;
  };

  server.tool('get_config', 'Read the ServiceBay app config (secrets like password hash and SMTP password redacted)', {}, async () => {
    const config = await getConfig();
    return textResult(sanitizeConfig(config));
  });

  // Allowlist: only fields the LLM is allowed to change without explicit user
  // intervention. Auth, OIDC, and notification credentials are deliberately
  // excluded — those need a human in the loop.
  const ConfigPatchSchema = z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    serverName: z.string().max(64).optional(),
    domain: z.string().max(255).optional(),
    autoUpdate: z.object({
      enabled: z.boolean().optional(),
      schedule: z.string().optional(),
    }).partial().optional(),
    templateSettings: z.record(z.string(), z.string()).optional(),
  }).strict();

  server.tool(
    'update_config',
    'Update select ServiceBay config fields. Allowed: logLevel, serverName, domain, autoUpdate, templateSettings. Auth/OIDC/SMTP are intentionally excluded.',
    { patch: ConfigPatchSchema.describe('Partial config to merge') },
    async ({ patch }) => {
      try {
        const current = await getConfig();
        const merged: Partial<AppConfig> = {};
        if (patch.logLevel !== undefined) merged.logLevel = patch.logLevel;
        if (patch.serverName !== undefined) merged.serverName = patch.serverName;
        if (patch.domain !== undefined) merged.domain = patch.domain;
        if (patch.templateSettings !== undefined) merged.templateSettings = patch.templateSettings;
        if (patch.autoUpdate) {
          merged.autoUpdate = { ...current.autoUpdate, ...patch.autoUpdate };
        }
        const updated = await updateConfig(merged);
        return textResult({ ok: true, config: sanitizeConfig(updated) });
      } catch (err) {
        return errorResult(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Get Unmanaged Bundles (ARCH-14, #846) ---
  server.tool(
    'get_unmanaged_bundles',
    'List unmanaged service bundles detected on a node — clusters of legacy systemd/docker units that ServiceBay can merge into managed Quadlet stacks. Returns each bundle\'s id, displayName, severity, hints, and member services.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      const bundles = getUnmanagedBundles(nodeName);
      return textResult(bundles);
    },
  );

  // --- Set Boot Next USB (#930) ---
  // Gated under 'destroy' scope. Sets BootNext to a USB UEFI entry and optionally reboots.
  server.tool(
    'set_boot_next_usb',
    'Configure UEFI BootNext one-shot target to boot from the installation USB next reboot, or clear current settings.',
    {
      action: z.enum(['list', 'set', 'clear']).optional().default('set').describe('Action: list candidates, set boot next, or clear active boot next'),
      bootNum: z.string().regex(/^[0-9A-Fa-f]{4}$/, 'Must be a 4-digit hex number').optional().describe('4-digit hex boot number (required for set if auto-detect not desired)'),
      reboot: z.boolean().optional().default(false).describe('Whether to reboot the system immediately after setting'),
      node: nodeParam,
    },
    async ({ action, bootNum, reboot, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        
        if (action === 'clear') {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -N' }) as { code?: number; stderr?: string };
          if (res.code !== 0) {
            return errorResult(`Failed to clear BootNext: ${res.stderr}`);
          }
          return textResult({ success: true, message: 'UEFI BootNext cleared successfully.' });
        }
        
        if (action === 'list') {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
          if (res.code !== 0) {
            return errorResult('Failed to query efibootmgr');
          }
          return textResult(parseEfibootmgr(res.stdout ?? ''));
        }
        
        // action === 'set'
        let targetBootNum = bootNum;
        if (!targetBootNum) {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
          if (res.code === 0) {
            const stdout = res.stdout ?? '';
            const lines = stdout.split('\n');
            for (const line of lines) {
              if (line.startsWith('Boot') && !line.startsWith('BootOrder') && !line.startsWith('BootNext') && !line.startsWith('BootCurrent')) {
                const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
                if (match) {
                  const num = match[1];
                  const desc = match[3];
                  if (desc.toLowerCase().includes('usb') || desc.toLowerCase().includes('removable') || desc.includes('\\EFI\\boot\\')) {
                    targetBootNum = num;
                    break;
                  }
                }
              }
            }
          }
        }
        
        if (!targetBootNum) {
          return errorResult('No USB boot entry found or specified');
        }
        
        await agent.sendCommand('exec', { command: `sudo -n efibootmgr -A -b ${targetBootNum}` });
        const resBootNext = await agent.sendCommand('exec', { command: `sudo -n efibootmgr -n ${targetBootNum}` }) as { code?: number; stderr?: string };
        if (resBootNext.code !== 0) {
          return errorResult(`Failed to set BootNext: ${resBootNext.stderr}`);
        }
        
        if (reboot) {
          agent.sendCommand('exec', { command: 'systemctl reboot' }).catch(() => {});
        }
        
        return textResult({
          success: true,
          bootNum: targetBootNum,
          message: reboot ? 'One-shot BootNext set. System is rebooting.' : 'One-shot BootNext set successfully.',
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Verify USB boot reinstall-readiness (#1236) ---
  // Read-only: reports whether the firmware has an active USB/removable UEFI
  // entry to boot from, so the launcher (#1231) can confirm "reinstall-ready"
  // (and surface a fix when it isn't) BEFORE setting BootNext + rebooting.
  server.tool(
    'verify_usb_boot',
    'Check whether the node can boot from USB for a reinstall: reports if an active USB/removable UEFI boot entry exists, with a fix hint when it does not. Read-only; does not change boot order.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
        if (res.code !== 0) {
          return errorResult('Failed to query efibootmgr (is this a UEFI node with efibootmgr installed?)');
        }
        const parsed = parseEfibootmgr(res.stdout ?? '');
        const readiness = assessUsbBootReadiness(parsed);
        return textResult({
          node: nodeName,
          reinstallReady: readiness.reinstallReady,
          activeUsbEntries: readiness.activeUsbEntries,
          usbCandidates: readiness.usbCandidates,
          bootNext: parsed.bootNext,
          bootCurrent: parsed.bootCurrent,
          bootOrder: parsed.bootOrder,
          ...(readiness.hint ? { hint: readiness.hint } : {}),
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Reboot Node (#1235) ---
  // Plain node reboot, distinct from set_boot_next_usb (no boot-order change).
  // Gated under 'destroy' scope + allowMutations. Not in DESTRUCTIVE_TOOLS: a
  // reboot doesn't mutate disk, so a pre-mutation snapshot would be wasted work
  // and would delay the reboot. The agent layer falls back to a direct SSH
  // reboot when the agent process itself is unreachable.
  server.tool(
    'reboot_node',
    'Reboot a node now. Distinct from set_boot_next_usb — this does not change boot order. Falls back to a direct SSH reboot when the agent process is unreachable but the box is up.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const { via } = await agent.rebootNode();
        return textResult({
          success: true,
          node: nodeName,
          via,
          message: `Reboot initiated on ${nodeName} (via ${via}). The node will be unreachable for a short while.`,
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Factory Reset (#1237) ---
  // Highest blast radius: wraps performStackReset (the same engine behind
  // /api/system/stacks/reset, which has caused total data loss). Guards:
  //   - destroy scope + allowMutations (safeHandler)
  //   - DESTRUCTIVE_TOOLS ⇒ automatic pre-reset system snapshot + operator email
  //   - `confirm` must EXACTLY equal the node name, and `node` is required
  //     (no first-node default) so it can't fire on the wrong/implicit box
  //   - preserve defaults to performStackReset's safe DEFAULT_PRESERVE; pass
  //     [] for a full nuke. The engine's own path-whitelist + validation gate
  //     still apply underneath.
  server.tool(
    'factory_reset',
    'DESTRUCTIVE: reset a node toward factory state via the stack-reset engine — stops and removes all non-protected services and wipes their data under DATA_DIR. `confirm` must exactly equal the node name to proceed. Takes an automatic pre-reset snapshot. `preserve` keeps reset groups (omit for the safe default; pass [] for a full wipe).',
    {
      node: z.string().min(1).describe('Node to factory-reset. Required — there is deliberately no default for a node-wide wipe.'),
      confirm: z.string().describe('Must exactly equal `node` to confirm intent. Any mismatch refuses the reset.'),
      preserve: z.array(z.string()).optional().describe('Reset groups to preserve. Omit for the safe default-preserve set; pass [] for a full nuke.'),
    },
    async ({ node, confirm, preserve }) => {
      if (confirm !== node) {
        return errorResult(
          `Refusing factory reset: \`confirm\` must exactly equal the node name "${node}". ` +
          `This stops + removes every non-protected service on the node and wipes its data.`,
        );
      }
      try {
        const result = await performStackReset({ node, preserve });
        return textResult({ success: true, ...result });
      } catch (err: unknown) {
        if (err instanceof StackResetError) return errorResult(err.message);
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Read-oriented file / disk / container tools (#1872) ---
  // These replace ad-hoc `exec_command` calls (cat/ls/find/du/podman exec)
  // with typed, path-jailed handlers. All four are NON-destructive: none is
  // in DESTRUCTIVE_TOOLS, so calling them never fires snapshotBeforeMutation
  // (no servicebay-full-*-auto.tar.gz). read_file/list_dir are jailed to
  // JAIL_ROOT (/mnt/data) lexically AND confirmed server-side with realpath
  // (catches a symlink that points out of the jail). disk_usage reuses the
  // disk probe's single du source. container_exec takes an argv array, so the
  // host shell never parses the payload.

  server.tool(
    'read_file',
    `Read a UTF-8 text file on a node, jailed to ${JAIL_ROOT} (service data dirs live here). Use this instead of \`exec_command cat …\`. The path is resolved and rejected if it escapes the jail (\`..\`, an absolute path outside it, or a symlink pointing out). Returns the file content (size-capped). For binary or huge files use exec_command deliberately.`,
    {
      path: z.string().min(1).describe(`File path; relative paths are anchored at ${JAIL_ROOT}. Must resolve inside ${JAIL_ROOT}.`),
      maxBytes: z.number().int().min(1).max(5_000_000).optional().describe('Max bytes to read (default 1 MiB). Larger files are rejected — narrow with exec_command if you truly need them.'),
      node: nodeParam,
    },
    async ({ path: reqPath, maxBytes, node }) => {
      const jailed = jailPath(reqPath);
      if (!jailed.ok) return errorResult(jailed.error);
      const limit = maxBytes ?? 1_048_576;
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // Symlink-escape guard, then regular-file/size guard. Lexical
        // jailPath() can't see a symlink that points out of the jail;
        // `realpath -m` resolves it on the box. argv form — no shell parsing.
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath);
        if (escape) return errorResult(escape);
        const bad = await assertReadableRegularFile(exec, jailed.path, reqPath, limit);
        if (bad) return errorResult(bad);
        const content = await exec.readFile(jailed.path);
        return textResult({ path: jailed.path, bytes: content.length, content: redactLogText(content) });
      } catch (err) {
        return errorResult(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // #2142 — jailed write_file. Symmetric with read_file (same JAIL_ROOT +
  // realpath escape guard), but WRITING: it creates the parent directory,
  // writes the content, and sets core:core ownership so the file is owned by
  // the box's service user (not root) — matching what the install runner
  // produces. Mutating (scope=mutate), so it rides the allowMutations gate;
  // NOT in DESTRUCTIVE_TOOLS (writing a data-dir file is additive, not a
  // data-losing wipe — no pre-mutation snapshot). The escape guard runs on the
  // PARENT dir (`realpath -m` on the file's own path resolves fine even when
  // the file doesn't exist yet, and rejects a parent symlink pointing out).
  server.tool(
    'write_file',
    `Write a UTF-8 text file on a node, jailed to ${JAIL_ROOT} (service data dirs live here). Use this instead of base64-piping content through \`exec_command\`. Creates the parent directory if missing and sets core:core ownership. The path is resolved and rejected if it escapes the jail (\`..\`, an absolute path outside it, or a symlink pointing out).`,
    {
      path: z.string().min(1).describe(`File path; relative paths are anchored at ${JAIL_ROOT}. Must resolve inside ${JAIL_ROOT}.`),
      content: z.string().describe('Full UTF-8 file content to write (overwrites any existing file).'),
      node: nodeParam,
    },
    async ({ path: reqPath, content, node }) => {
      const jailed = jailPath(reqPath);
      if (!jailed.ok) return errorResult(jailed.error);
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // Symlink-escape guard on the target itself. `realpath -m` resolves
        // even a not-yet-existing file (it resolves the existing prefix),
        // so a parent symlink that points out of the jail is still caught.
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath);
        if (escape) return errorResult(escape);
        // Parent-dir create (idempotent). Derive the parent lexically from the
        // already-jailed absolute path.
        const parent = jailed.path.slice(0, jailed.path.lastIndexOf('/')) || JAIL_ROOT;
        const mk = await exec.execSafe(['mkdir', '-p', '--', parent], { sudo: true });
        if (mk.code !== 0) {
          return errorResult(`Could not create parent directory "${parent}": ${(mk.stderr ?? '').trim() || `exit ${mk.code}`}`);
        }
        // Write the content via the agent's write_file (handles the transfer),
        // then set core:core ownership so the box's service user owns it.
        await exec.writeFile(jailed.path, content);
        const chown = await exec.execSafe(['chown', 'core:core', '--', jailed.path], { sudo: true });
        const ownershipSet = chown.code === 0;
        return textResult({
          path: jailed.path,
          bytes: Buffer.byteLength(content, 'utf8'),
          ownershipSet,
          ...(ownershipSet ? {} : { ownershipWarning: `File written but chown core:core failed: ${(chown.stderr ?? '').trim() || `exit ${chown.code}`}` }),
        });
      } catch (err) {
        return errorResult(`Error writing file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'list_dir',
    `List the entries of a directory on a node, jailed to ${JAIL_ROOT}. Use this instead of \`exec_command ls/find/wc -l\`. Each entry has name, type (file|dir|symlink|other), size (bytes) and mtime (Unix seconds). The path is rejected if it escapes the jail.`,
    {
      path: z.string().min(1).optional().describe(`Directory path; relative paths are anchored at ${JAIL_ROOT}. Defaults to ${JAIL_ROOT}.`),
      node: nodeParam,
    },
    async ({ path: reqPath, node }) => {
      const jailed = jailPath(reqPath ?? JAIL_ROOT);
      if (!jailed.ok) return errorResult(jailed.error);
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath ?? JAIL_ROOT);
        if (escape) return errorResult(escape);
        // `find -maxdepth 1` lists the dir's immediate children, one per line
        // with tab-separated type/size/mtime/name fields.
        const res = await exec.execSafe([
          'find', jailed.path, '-maxdepth', '1', '-mindepth', '1',
          '-printf', '%y\t%s\t%T@\t%f\n',
        ]);
        if (res.code !== 0) {
          return errorResult(`Cannot list "${jailed.path}": ${(res.stderr ?? '').trim() || `exit ${res.code}`}`);
        }
        const typeMap: Record<string, string> = { f: 'file', d: 'dir', l: 'symlink' };
        const entries = (res.stdout ?? '')
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [y, size, mtime, ...rest] = line.split('\t');
            return {
              name: rest.join('\t'),
              type: typeMap[y] ?? 'other',
              size: Number(size),
              mtime: Math.floor(Number(mtime)),
            };
          });
        return textResult({ path: jailed.path, count: entries.length, entries });
      } catch (err) {
        return errorResult(`Error listing directory: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'disk_usage',
    `Show the largest directories under ${JAIL_ROOT} (top-N by size). Use this instead of \`exec_command du\`. Reuses the same measurement as the disk diagnose probe's "show largest directories" action — there is one du implementation. Returns the raw \`du\` breakdown (size + path per line) and a parsed list.`,
    {
      top: z.number().int().min(1).max(50).optional().describe('How many directories to return (default 10).'),
      node: nodeParam,
    },
    async ({ top, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const breakdown = await largestDirsUnderDataDir(nodeName, top ?? 10);
        const entries = breakdown
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [size, ...rest] = line.split('\t');
            return { size: size?.trim() ?? '', path: rest.join('\t').trim() };
          });
        return textResult({ root: JAIL_ROOT, breakdown, entries });
      } catch (err) {
        return errorResult(`Error measuring disk usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'container_exec',
    'Run a command inside a named container via `podman exec`, passing an argv array (no host shell string). Use this instead of an ad-hoc `exec_command podman exec …`. The container name is validated; args are passed as a list so the host shell never parses them. Non-destructive by default — scoped to one container, not the host.',
    {
      container: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid container name').describe('Container name or id (e.g. media-jellyfin).'),
      args: z.array(z.string()).min(1).describe('Command + arguments as an argv array, e.g. ["cat", "/etc/os-release"]. Passed verbatim — no shell interpolation.'),
      node: nodeParam,
    },
    async ({ container, args, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // argv form end-to-end via safe_exec: the agent runs `podman exec
        // <name> <args…>` without a host shell, so a metacharacter in args can
        // never start a new host command (the container name is also
        // regex-validated by the schema). Kept on execSafe (not execArgv) so
        // the argv is never shell-parsed end-to-end (the legacy `exec` trace
        // wrapper that swallowed the command was fixed in #1877).
        // `podman` is on the agent SAFE_EXEC_ALLOWLIST.
        const argv = ['podman', 'exec', container, ...args];
        const res = await exec.execSafe(argv);
        return textResult({
          container,
          command: argv.map(shellQuote).join(' '),
          exitCode: res.code,
          stdout: redactLogText(res.stdout ?? ''),
          stderr: redactLogText(res.stderr ?? ''),
        });
      } catch (err) {
        return errorResult(`Error running container command: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Access requests / approval workflow (#1818) ---
  // Programmatic surface over the same `config.accessRequests` list the
  // family portal feeds and the admin Settings page resolves. Lets an
  // agent (e.g. Solilos resident-onboarding, mdopp/solbay #355) file a
  // pending approval the admin acts on in the existing flow, then poll
  // its status to react on approval.
  //
  // Anti-spam cap mirrors the public POST route's MAX_PENDING (50).
  const MAX_PENDING_ACCESS_REQUESTS = 50;

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

  // Legacy entries written before #1824 carry the old `'resolved'`
  // status, which always meant the approve path — surface them as
  // `'approved'` so callers only ever see pending|approved|denied.
  const normalizeStatus = (s: AccessRequest['status']): 'pending' | 'approved' | 'denied' =>
    s === 'resolved' ? 'approved' : s;

  server.tool(
    'list_access_requests',
    'List access/approval requests on the admin\'s central list. Defaults to pending only; pass status="approved", "denied", or "all".',
    {
      status: z.enum(['pending', 'approved', 'denied', 'all']).optional().default('pending').describe('Filter by status. Default: pending.'),
    },
    async ({ status }) => {
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
    'Poll the status of one access request by id (as returned by file_access_request). Returns "pending" (awaiting an admin decision), "approved" (admin provisioned the user — proceed), "denied" (admin dismissed it — provision nothing and drop any captured data), or "not-found".',
    {
      id: z.string().min(1).describe('Request id returned by file_access_request.'),
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
    'Request a scoped, short-lived sb_ API token that a ServiceBay admin must approve. Names the scopes you need, a human reason, and a TTL in seconds. Returns a pending request id — NO token yet. Poll it with poll_token_request; the admin may approve with NARROWED scopes (least privilege) or a shorter TTL, or deny. This tool itself needs only the read scope: a request grants nothing until a human signs off.',
    {
      scopes: z.array(SCOPE_ENUM).min(1).describe(`Scopes to request (least→most: ${ALL_SCOPES.join(', ')}). Ask for the minimum the task needs; the admin can only grant these or fewer.`),
      reason: z.string().trim().min(1).max(1000).describe('Why the token is needed — the justification the admin weighs (e.g. "deploy one service, tor.dopp.cloud").'),
      ttl_seconds: z.number().int().positive().max(MAX_TTL_SECS).describe(`Requested time-to-live in seconds (max ${MAX_TTL_SECS} = 30d). The admin can shorten it. The token auto-expires and is deleted from storage.`),
    },
    async ({ scopes, reason, ttl_seconds }) => {
      try {
        const view = await submitTokenRequest({
          requestedScopes: scopes,
          requestedTtlSecs: ttl_seconds,
          reason,
          requestedBy: opts?.auth?.user,
        });
        return textResult({
          ok: true,
          id: view.id,
          status: view.status,
          message: `Token request filed. A ServiceBay admin must approve it (Settings → MCP). Poll with poll_token_request(id="${view.id}").`,
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

  server.tool(
    'list_token_requests',
    'List scoped-token requests (request_token lifecycle) for admin/audit visibility. Defaults to pending; pass status="approved", "denied", or "all". Never returns token secrets — only the request metadata, granted scopes, expiry, and minted token id.',
    {
      status: z.enum(['pending', 'approved', 'denied', 'all']).optional().default('pending').describe('Filter by status. Default: pending.'),
    },
    async ({ status }) => {
      const requests = await listTokenRequests(status as TokenRequestStatus | 'all');
      return textResult({ requests });
    },
  );

  return server;
}
