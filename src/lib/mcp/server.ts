import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { DigitalTwinStore } from '@/lib/store/twin';
import {
  getAllSystemServices,
} from '@/lib/manager';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getTemplates, getReadme, getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { listNodes, getNodeConnection, verifyNodeConnection } from '@/lib/nodes';
import { agentManager } from '@/lib/agent/manager';
import { MonitoringStore } from '@/lib/monitoring/store';
import { CheckRunner } from '@/lib/monitoring/runner';
import type { CheckConfig, CheckType } from '@/lib/monitoring/types';
import { getConfig, updateConfig, type AppConfig, type ProxyHostEntry } from '@/lib/config';
import {
  getBackupHistory,
  runBackup as runBackupService,
  isBackupRunning,
} from '@/lib/backup/service';
import { restoreSystemBackup } from '@/lib/systemBackup';

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

export function createMcpServer() {
  const server = new McpServer({
    name: 'servicebay',
    version: '1.0.0',
  });

  // --- List Nodes ---
  server.tool('list_nodes', 'List all registered nodes with connection status and resources', {}, async () => {
    const twin = DigitalTwinStore.getInstance();
    const snapshot = twin.getSnapshot();
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
    const twin = DigitalTwinStore.getInstance();
    const nodeName = await resolveNode(node);
    const services = twin.nodes[nodeName]?.services || [];
    return textResult(services);
  });

  // --- List Containers ---
  server.tool('list_containers', 'List running containers with image, state, ports', { node: nodeParam }, async ({ node }) => {
    const twin = DigitalTwinStore.getInstance();
    const nodeName = await resolveNode(node);
    const containers = twin.nodes[nodeName]?.containers || [];
    return textResult(containers);
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
          stdout: result.stdout ?? '',
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
          stdout: result.stdout ?? '',
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
      return textResult(files);
    },
  );

  // --- Deploy Service ---
  server.tool(
    'deploy_service',
    'Deploy a new service or update an existing one from kube YAML',
    {
      name: z.string().describe('Service name'),
      kubeContent: z.string().describe('Kubernetes/Podman kube YAML content'),
      yamlContent: z.string().optional().describe('Companion compose/config YAML content'),
      yamlFileName: z.string().optional().describe('Filename for the companion YAML'),
      node: nodeParam,
    },
    async ({ name, kubeContent, yamlContent, yamlFileName, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.deployKubeService(nodeName, name, kubeContent, yamlContent ?? '', yamlFileName ?? `${name}.yaml`);
      return textResult(`Service "${name}" deployed successfully`);
    },
  );

  // --- Delete Service ---
  server.tool(
    'delete_service',
    'Delete a service and its associated files',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.deleteService(nodeName, name);
      return textResult(`Service "${name}" deleted successfully`);
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
    const twin = DigitalTwinStore.getInstance();
    const nodeName = await resolveNode(node);
    const nodeTwin = twin.nodes[nodeName];

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
    const twin = DigitalTwinStore.getInstance();
    const snapshot = twin.getSnapshot();
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

  // --- Get Monitoring Checks ---
  server.tool('get_monitoring_checks', 'List all monitoring health checks with their latest results', {}, async () => {
    const checks = MonitoringStore.getChecks();
    const result = checks.map(check => ({
      ...check,
      lastResult: MonitoringStore.getLastResult(check.id),
    }));
    return textResult(result);
  });

  // --- Get Gateway Status ---
  server.tool('get_gateway_status', 'Get gateway info: public IP, port mappings, uptime', {}, async () => {
    const twin = DigitalTwinStore.getInstance();
    const snapshot = twin.getSnapshot();
    return textResult(snapshot.gateway);
  });

  // --- Get Proxy Routes ---
  server.tool('get_proxy_routes', 'Get reverse proxy routes configuration', {}, async () => {
    const twin = DigitalTwinStore.getInstance();
    const snapshot = twin.getSnapshot();
    return textResult(snapshot.proxy);
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
        const { POST } = await import('@/app/api/system/diagnose/route');
        const fakeRequest = new Request('http://localhost/api/system/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node: nodeName }),
        });
        const res = await POST(fakeRequest);
        const data = await res.json();
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
    async ({ name, kubeContent, yamlContent, yamlFileName, node }) => {
      const nodeName = await resolveNode(node);
      try {
        await ServiceManager.deployKubeService(
          nodeName,
          name,
          kubeContent,
          yamlContent ?? '',
          yamlFileName ?? `${name}.yaml`,
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

  // --- Monitoring checks ---

  const checkTypeSchema = z.enum([
    'http', 'ping', 'script', 'podman', 'service', 'systemd', 'fritzbox', 'node', 'agent', 'backup',
  ]);

  server.tool(
    'create_monitoring_check',
    'Create a new monitoring check (HTTP, ping, container, service, …). Returns the created check including generated id.',
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
      MonitoringStore.saveCheck(check);
      return textResult(check);
    },
  );

  server.tool(
    'delete_monitoring_check',
    'Delete a monitoring check by id (use list_monitoring_checks/get_monitoring_checks to find ids).',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const before = MonitoringStore.getChecks().length;
      MonitoringStore.deleteCheck(id);
      const after = MonitoringStore.getChecks().length;
      if (before === after) return errorResult(`No check with id "${id}" found`);
      return textResult({ deleted: id });
    },
  );

  server.tool(
    'run_check_now',
    'Run a monitoring check immediately and persist the result. Returns the result.',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const check = MonitoringStore.getChecks().find(c => c.id === id);
      if (!check) return errorResult(`No check with id "${id}" found`);
      try {
        const result = await CheckRunner.run(check);
        MonitoringStore.saveResult(result);
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
      channel: z.enum(['stable', 'test', 'dev']).optional(),
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

  return server;
}
