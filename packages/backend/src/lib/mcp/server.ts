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
import { mergeServices, type DiscoveredService } from '@/lib/migration';
import {
  getAllSystemServices,
} from '@/lib/manager';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getTemplates, getReadme, getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { listNodes, getNodeConnection } from '@/lib/nodes';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { agentManager } from '@/lib/agent/manager';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import type { CheckConfig, CheckType } from '@/lib/health/types';
import { getConfig, updateConfig, type AppConfig, type ProxyHostEntry } from '@/lib/config';
import {
  getBackupHistory,
  runBackup as runBackupService,
  isBackupRunning,
} from '@/lib/backup/service';
import { restoreSystemBackup } from '@/lib/systemBackup';
import { guardMutation, guardExec, snapshotBeforeMutation } from './safety';
import { recordAudit } from './audit';
import { notifyDestructiveOp } from './notify';
import { redactLogText, redactServiceFiles } from './redact';
import type { ApiScope } from '@/lib/auth/apiScope';

interface McpAuthContext {
  user: string;
  scopes: ApiScope[];
  tokenId?: string;
}

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
 * Tools that mutate state. Calls are gated on `config.mcp.allowMutations`
 * (true | absent ⇒ allowed; false ⇒ blocked).
 */
const MUTATING_TOOLS = new Set([
  'start_service', 'stop_service', 'restart_service',
  'deploy_service', 'delete_service', 'rename_service', 'update_service_yaml',
  'restore_trashed_service', 'purge_trashed_service',
  'add_proxy_route', 'remove_proxy_route',
  'create_health_check', 'delete_health_check', 'run_check_now',
  'run_backup', 'restore_backup',
  'update_config', 'exec_command', 'refresh_agent',
  'merge_unmanaged_bundle',
  'set_boot_next_usb',
]);

/**
 * Per-tool required scope. Bearer-token auth refuses any tool whose scope
 * isn't in the token's set. Cookie auth has all scopes for back-compat.
 *
 *   read       lookups + diagnose + log readers
 *   lifecycle  start/stop/restart + run_check_now + refresh + run_backup
 *   mutate     create/update/add + config writes — additive changes
 *   destroy    delete/restore/purge — irreversible state edits
 *   exec       exec_command — split off from `destroy` (#591) so a token
 *              can grant config writes without shell access
 */
export const TOOL_SCOPES: Record<string, ApiScope> = {
  // read
  list_nodes: 'read', list_services: 'read', list_containers: 'read',
  get_service_logs: 'read', get_container_logs: 'read', get_service_files: 'read',
  list_templates: 'read', get_template_readme: 'read', get_template_yaml: 'read',
  get_template_variables: 'read',
  get_system_info: 'read', get_network_graph: 'read', get_health_checks: 'read',
  get_gateway_status: 'read', get_proxy_routes: 'read', get_config: 'read',
  get_podman_logs: 'read', list_system_services: 'read',
  list_backups: 'read', diagnose: 'read', verify_node_connection: 'read',
  list_trashed_services: 'read',
  get_unmanaged_bundles: 'read',
  // lifecycle
  start_service: 'lifecycle', stop_service: 'lifecycle', restart_service: 'lifecycle',
  run_check_now: 'lifecycle', refresh_agent: 'lifecycle',
  run_backup: 'lifecycle',
  // mutate
  deploy_service: 'mutate', update_service_yaml: 'mutate', rename_service: 'mutate',
  add_proxy_route: 'mutate', create_health_check: 'mutate',
  restore_trashed_service: 'mutate',
  merge_unmanaged_bundle: 'mutate',
  // mutate (config writes, allow-listed to safe keys — see update_config tool)
  update_config: 'mutate',
  // destroy
  delete_service: 'destroy', delete_health_check: 'destroy',
  remove_proxy_route: 'destroy', restore_backup: 'destroy',
  purge_trashed_service: 'destroy',
  set_boot_next_usb: 'destroy',
  // exec (shell — own scope so tokens can grant config writes without it)
  exec_command: 'exec',
};

/**
 * Decide whether a token with `tokenScopes` may call a tool that
 * requires `required`. Encapsulates the back-compat rule (#591) that
 * tokens issued before the split — when `exec_command` was tagged as
 * `destroy` — still get exec via their `destroy` grant.
 *
 * Exported pure helper so the scope semantics are testable without
 * spinning up the whole MCP server.
 */
export function tokenHasScope(tokenScopes: readonly ApiScope[], required: ApiScope): boolean {
  if (tokenScopes.includes(required)) return true;
  if (required === 'exec' && tokenScopes.includes('destroy')) return true;
  return false;
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
  'merge_unmanaged_bundle',
  'set_boot_next_usb',
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
function safeHandler(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...handlerArgs: any[]) => Promise<ToolResult>,
  auth?: McpAuthContext,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...handlerArgs: any[]): Promise<ToolResult> => {
    const args = (handlerArgs[0] && typeof handlerArgs[0] === 'object') ? handlerArgs[0] : {};
    const start = Date.now();
    let outcome: 'ok' | 'error' | 'blocked' = 'ok';
    let errorMessage: string | undefined;
    try {
      // Scope check (token auth only — cookie has all scopes by design).
      const required = TOOL_SCOPES[toolName] ?? 'read';
      if (auth && !tokenHasScope(auth.scopes, required)) {
        outcome = 'blocked';
        errorMessage = `Token scope '${required}' required for ${toolName}; this token has [${auth.scopes.join(',')}]`;
        return { content: [{ type: 'text' as const, text: errorMessage }], isError: true as const };
      }
      if (MUTATING_TOOLS.has(toolName)) {
        const blocked = await guardMutation(toolName);
        if (blocked) {
          outcome = 'blocked';
          errorMessage = blocked.content[0]?.text;
          return blocked;
        }
      }
      if (toolName === 'exec_command' && typeof args.command === 'string') {
        const denied = await guardExec(args.command);
        if (denied) {
          outcome = 'blocked';
          errorMessage = denied.content[0]?.text;
          return denied;
        }
      }
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
  };
}

export function createMcpServer(opts?: { auth?: McpAuthContext }) {
  const baseServer = new McpServer({
    name: 'servicebay',
    version: '1.0.0',
  });
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
  server.tool('list_services', 'List services on a node with status, ports, volumes', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getServices(nodeName));
  });

  // --- List Containers ---
  server.tool('list_containers', 'List running containers with image, state, ports', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getContainers(nodeName));
  });

  // --- Get Service Logs ---
  server.tool(
    'get_service_logs',
    'Fetch systemd journal logs for a service. Use `since` (Unix seconds) on subsequent calls to get only newer lines for a debug-loop pattern.',
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
    'Fetch container stdout/stderr logs. Use `since` (Unix seconds) on subsequent calls to get only newer lines for a debug-loop pattern.',
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

  // --- Get Service Files ---
  server.tool(
    'get_service_files',
    'Get kube YAML, compose YAML, and systemd unit files for a service',
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
  server.tool('get_proxy_routes', 'Get reverse proxy routes configuration', {}, async () => {
    return textResult(getStoreSnapshot().proxyState);
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
    'Replace a service\'s kube YAML and redeploy it. Use `get_service_files` first, modify, then call this. The file is written and `systemctl --user daemon-reload` + service restart is triggered.',
    {
      name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid service name').describe('Service name'),
      kubeContent: z.string().min(1).describe('Full kube YAML content (replaces existing)'),
      yamlContent: z.string().optional().describe('Optional companion compose/config YAML'),
      yamlFileName: z.string().optional().describe('Filename for companion YAML (default: <name>.yaml)'),
      node: nodeParam,
    },
    async ({ name, kubeContent, yamlFileName, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const resolvedYamlFileName = yamlFileName ?? `${name}.yml`;
        const generatedKubeUnit = `[Kube]\nYaml=${resolvedYamlFileName}\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;
        await ServiceManager.deployKubeService(
          nodeName,
          name,
          generatedKubeUnit,
          kubeContent,
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

  // --- Merge Unmanaged Bundle (ARCH-14, #846) ---
  // Destructive: stops legacy units, replaces them with a single managed
  // Quadlet stack. safeHandler auto-snapshots before, audits the call,
  // and emails on success. Use `dryRun: true` to get the migration plan
  // without touching disk.
  server.tool(
    'merge_unmanaged_bundle',
    'Merge an unmanaged service bundle into a single managed Quadlet stack. Stops the legacy units, generates a combined pod spec, and registers the new service. Pass dryRun:true to preview the plan without writing.',
    {
      bundleId: z.string().describe('Bundle id returned by get_unmanaged_bundles'),
      newName: z.string().min(1).describe('Target service name for the merged stack'),
      node: nodeParam,
      dryRun: z.boolean().optional().describe('When true, return the migration plan without applying changes'),
    },
    async ({ bundleId, newName, node, dryRun }) => {
      const nodeName = await resolveNode(node);
      return mergeUnmanagedBundleHandler({ bundleId, newName, nodeName, dryRun });
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
          const stdout = res.stdout ?? '';
          const entries: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }> = [];
          const lines = stdout.split('\n');
          let bootNext: string | null = null;
          let bootCurrent: string | null = null;
          let bootOrder: string[] = [];
          
          for (const line of lines) {
            if (line.startsWith('BootNext:')) {
              bootNext = line.replace('BootNext:', '').trim();
            } else if (line.startsWith('BootCurrent:')) {
              bootCurrent = line.replace('BootCurrent:', '').trim();
            } else if (line.startsWith('BootOrder:')) {
              bootOrder = line.replace('BootOrder:', '').trim().split(',');
            } else if (line.startsWith('Boot')) {
              const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
              if (match) {
                const num = match[1];
                const active = match[2] === '*';
                const description = match[3];
                entries.push({
                  bootNum: num,
                  name: description.split('\t')[0] || description,
                  active,
                  description,
                  current: bootCurrent === num,
                });
              }
            }
          }
          const candidates = entries.filter(e => 
            e.description.toLowerCase().includes('usb') || 
            e.description.toLowerCase().includes('removable') ||
            e.description.toLowerCase().includes('disk') ||
            e.description.includes('\\EFI\\boot\\')
          );
          return textResult({ entries, candidates, bootNext, bootCurrent, bootOrder });
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

  return server;
}

/**
 * Pure-ish implementation of the `merge_unmanaged_bundle` MCP tool —
 * exposed for unit tests so the handler can be exercised without
 * spinning up the McpServer SDK. The `nodeName` is already resolved
 * (no `resolveNode` here so tests don't have to mock listNodes).
 */
export async function mergeUnmanagedBundleHandler(args: {
  bundleId: string;
  newName: string;
  nodeName: string;
  dryRun?: boolean;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const { bundleId, newName, nodeName, dryRun } = args;
  const bundle = getUnmanagedBundles(nodeName).find(b => b.id === bundleId);
  if (!bundle) {
    return errorResult(`No unmanaged bundle "${bundleId}" found on node "${nodeName}"`);
  }
  if (bundle.services.length < 2) {
    return errorResult(`Bundle "${bundleId}" has fewer than 2 services — nothing to merge`);
  }
  const services: DiscoveredService[] = bundle.services.map(s => ({
    serviceName: s.serviceName,
    containerNames: s.containerNames,
    containerIds: s.containerIds,
    podId: s.podId,
    unitFile: s.unitFile,
    sourcePath: s.sourcePath,
    status: s.status,
    type: s.type,
    nodeName: s.nodeName,
    discoveryHints: s.discoveryHints,
  }));
  const connection = nodeName === 'Local' ? undefined : await getNodeConnection(nodeName);
  const result = await mergeServices(services, newName, {
    dryRun: !!dryRun,
    connection: connection ?? undefined,
    initiator: 'mcp',
  });
  if (dryRun) return textResult({ dryRun: true, plan: result });
  return textResult({ ok: true, newName, mergedServices: services.map(s => s.serviceName) });
}
