/**
 * The MCP server factory + its safety layer.
 *
 * This file owns the *cross-cutting* half of the MCP surface — the auth
 * context, the safety flow every tool call passes through (one-shot binding →
 * scope gate → mutation/exec guards → destroy-tier approval gate →
 * snapshot/audit/notify), and the scope-filtered `tools/list` view.
 *
 * The tools themselves live in `tools/*.ts`, one module per tool group (#2384).
 * Each group module receives a `ToolServer` whose `.tool()` is already wrapped
 * in `safeHandler`, so a new tool is covered by the safety layer by
 * construction and cannot register around it. The policy tables the layer reads
 * (TOOL_SCOPES / MUTATING_TOOLS / DESTRUCTIVE_TOOLS + DESTRUCTIVE_TOOL_ACTIONS /
 * MCP_KERNEL_TOOLS) live in
 * `toolPolicy.ts` and are re-exported here so this module's public API is
 * unchanged.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerAssistResources } from './assistCatalog';
import { guardMutation, guardExec, snapshotBeforeMutation } from './safety';
import { recordAudit } from './audit';
import { notifyDestructiveOp } from './notify';
import { submitApproval, registerMcpDispatcher } from '@/lib/approvals';
import { dispatchWithServer } from './dispatchTool';
import { type ApiScope } from '@/lib/auth/apiScope';
import { consumeSingleUseToken } from '@/lib/auth/apiTokens';
import {
  MUTATING_TOOLS,
  destructiveCallLabel,
  TOOL_SCOPES,
  MCP_KERNEL_TOOLS,
  tokenHasScope,
  isToolVisibleForScopes,
  isDestroyTierTool,
} from './toolPolicy';
import type { ToolResult, ToolServer } from './tools/context';
import { registerNodeTools } from './tools/nodeTools';
import { registerServiceTools } from './tools/serviceTools';
import { registerContainerTools } from './tools/containerTools';
import { registerLogTools } from './tools/logTools';
import { registerTemplateTools } from './tools/templateTools';
import { registerProxyTools } from './tools/proxyTools';
import { registerHealthTools } from './tools/healthTools';
import { registerBackupTools } from './tools/backupTools';
import { registerConfigTools } from './tools/configTools';
import { registerAssistTools } from './tools/assistTools';
import { registerFileTools } from './tools/fileTools';
import { registerRequestTools } from './tools/requestTools';
import { registerBootTools } from './tools/bootTools';

// The tool-policy tables are re-exported from their original home so external
// importers (tests, tokenRequests, the drift report) keep working unchanged.
export { TOOL_SCOPES, MCP_KERNEL_TOOLS, tokenHasScope, isToolVisibleForScopes };

interface McpAuthContext {
  user: string;
  scopes: ApiScope[];
  tokenId?: string;
  // One-shot owner-approved elevation (#2245). Present only for a token minted
  // through the approved request_token one-shot flow: it holds an elevated
  // scope BOUND to exactly one op, and burns after one use. The gate enforces
  // the binding + burns the token; a normal token leaves these unset.
  oneShotOp?: { toolName: string; service?: string };
  singleUse?: boolean;
}

// Wire the approvals kernel's MCP-tool re-dispatch (#2234) to a no-auth
// (operator) MCP server. Registered at module load — server.ts is loaded at
// process startup — so approving a persisted MCP approval runs the tool. The
// dispatcher closes over `createMcpServer` here rather than dispatchTool.ts
// importing server.ts, which would close an approvals ↔ mcp dependency cycle.
registerMcpDispatcher((toolName, args) => dispatchWithServer(() => createMcpServer(), toolName, args));

/**
 * A destroy-tier approval's `service` anchor for the operator's Approvals UI
 * (#2234). Most destructive tools name a target in `args.name` (delete_service,
 * delete_health_check) or `args.service` — use it when it's a single safe path
 * segment so the request reads e.g. "delete_service: media". Otherwise fall
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
    // Resolved per CALL, not per tool (#2419): a multi-action tool can carry one
    // destructive action among reversible ones (`manage_service` force-update),
    // and only that action gets the snapshot + operator email.
    const destructive = destructiveCallLabel(toolName, args);
    try {
      if (destructive) {
        // Best-effort: don't block the mutation if the snapshot fails.
        await snapshotBeforeMutation(destructive, args);
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
      if (destructive && outcome === 'ok') {
        void notifyDestructiveOp({ tool: destructive, caller: auth?.user, args, ts }).catch(() => undefined);
      }
    }
  })();
}

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
function safeHandler(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...handlerArgs: any[]) => Promise<ToolResult>,
  auth?: McpAuthContext,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...handlerArgs: any[]): Promise<ToolResult> => {
    const args = (handlerArgs[0] && typeof handlerArgs[0] === 'object') ? handlerArgs[0] : {};
    // One-shot elevation binding (#2245): a token minted through the approved
    // request_token one-shot flow carries an elevated scope but is BOUND to
    // exactly one op. It may ONLY invoke its bound tool (and, when a target
    // service was named, only against that service). Any other call — even a
    // read — is refused, so the elevated grant can't be redirected. The token
    // then burns after its one successful op (below). Checked before the scope
    // check so an off-target call is refused up front.
    if (auth?.oneShotOp) {
      const bound = auth.oneShotOp;
      if (toolName !== bound.toolName) {
        const msg = `This is a one-shot token bound to "${bound.toolName}"${bound.service ? ` on ${bound.service}` : ''}; it cannot call ${toolName}.`;
        void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth.user, outcome: 'blocked', durationMs: 0, args, errorMessage: msg });
        return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
      }
      if (bound.service && coerceApprovalService(args) !== bound.service) {
        const msg = `This one-shot token is bound to "${bound.toolName}" on "${bound.service}"; the call targets a different service.`;
        void recordAudit({ ts: new Date().toISOString(), tool: toolName, caller: auth.user, outcome: 'blocked', durationMs: 0, args, errorMessage: msg });
        return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
      }
    }
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
    // A one-shot token (#2245) already went through owner approval when it was
    // minted, so it must NOT park again — it runs its one bound op inline (then
    // burns below). Only a NON-one-shot token proposing a destroy-tier op parks.
    if (auth && !auth.oneShotOp && isDestroyTierTool(toolName)) {
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

    const result = await runToolWithSideEffects(toolName, args, handler, handlerArgs, auth);
    // Single-use burn (#2245): a one-shot elevated token is revoked after its
    // one op RAN (isError = the tool reported a logical failure — then we do NOT
    // burn, so the caller can retry the still-valid grant within its short TTL).
    // Burn is fire-and-forget-safe but awaited so a follow-up call in the same
    // tick can't slip through before the row is gone.
    if (auth?.singleUse && auth.tokenId && !(result && typeof result === 'object' && (result as { isError?: boolean }).isError)) {
      await consumeSingleUseToken(auth.tokenId).catch(() => undefined);
    }
    return result;
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
        '3. `get_logs(source="container", container=id)` — fetch that container\'s logs.',
        'For whole-unit (systemd) logs use `get_logs(source="service", name=…)` instead of per-container logs.',
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
    // The underlying McpServer, exposed so the transport boundary can register
    // the async half of the assist catalog (prompts) via registerAssistPrompts
    // (#2326 s6). Resources are registered synchronously below.
    __baseServer: baseServer,
  };

  // --- Native assist-catalog distribution (#2326 s6) ---
  // Expose the SAME assist catalog (list_assists/get_assist stay, additive) as
  // MCP-native resources so any client can list + read assists without our tool
  // names. Read-tier knowledge: assists carry no secrets (secret-scan gate) and
  // are already readable via the read-scoped tools, so this adds no privilege.
  // Resources register synchronously (template defers enumeration); the prompt
  // half is async and wired at the transport boundary via registerAssistPrompts.
  registerAssistResources(baseServer);

  // --- Tool groups (#2384) ---
  // Every group gets the SAME safety-wrapped registrar, so no module can
  // register a tool that skips the gates above. `caller` is the token identity
  // the two provenance-stamping tools record; everything else ignores it.
  const registration = { server: server as ToolServer, caller: opts?.auth?.user };
  registerNodeTools(registration);
  registerServiceTools(registration);
  registerContainerTools(registration);
  registerLogTools(registration);
  registerTemplateTools(registration);
  registerProxyTools(registration);
  registerHealthTools(registration);
  registerBackupTools(registration);
  registerConfigTools(registration);
  registerAssistTools(registration);
  registerFileTools(registration);
  registerRequestTools(registration);
  registerBootTools(registration);

  // Scope-filtered + deterministically-ordered tools/list (#2325).
  //
  // Enforcement is unchanged — every tool above is registered with its
  // safeHandler, which remains the authority: a filtered-out tool called by id
  // still hits the scope gate and is refused. This ONLY changes *visibility*:
  //   - a read-only token's advertised list omits mutate/destroy/exec tools
  //     (least-privilege + fewer wrong picks + fewer tokens), and
  //   - the list is sorted by name so it's deterministic + stable per token
  //     across requests (prompt-cache friendliness).
  //
  // We wrap the SDK's own list handler rather than rebuild the tool-definition
  // serialization (zod→JSON-schema) so the shapes never drift from the SDK.
  applyToolListView(baseServer, opts?.auth?.scopes);

  return server;
}

/**
 * Override the low-level `tools/list` handler on `baseServer.server` to (1)
 * hide tools the current token can't call and (2) sort the survivors by name
 * (#2325). It delegates to the SDK's default handler (installed by the first
 * `.tool()` registration) for the actual tool-definition serialization, then
 * filters + sorts its result — so this stays robust to SDK schema changes.
 */
function applyToolListView(baseServer: McpServer, scopes: readonly ApiScope[] | undefined) {
  // The low-level Server keeps request handlers in a private Map keyed by the
  // method literal ("tools/list"). Read the SDK's default handler so we can
  // delegate to it, then reinstall our filtering/sorting wrapper over it.
  const lowLevel = baseServer.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: { name: string }[] }>>;
  };
  const defaultHandler = lowLevel._requestHandlers.get('tools/list');
  if (!defaultHandler) return; // no tools registered → nothing to view
  baseServer.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const full = await defaultHandler(request, extra);
    const tools = full.tools
      .filter(t => isToolVisibleForScopes(t.name, scopes))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ...full, tools };
  });
}
