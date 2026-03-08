import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DigitalTwinStore } from '@/lib/store/twin';
import {
  getServiceLogs, startService, stopService, restartService,
  getServiceFiles, deleteService, renameService,
  getPodmanLogs, getAllSystemServices,
  createVolume, removeVolume,
} from '@/lib/manager';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getTemplates, getReadme, getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { listNodes, getNodeConnection, verifyNodeConnection } from '@/lib/nodes';
import { agentManager } from '@/lib/agent/manager';
import { MonitoringStore } from '@/lib/monitoring/store';

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
    'Fetch systemd and podman logs for a service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      const logs = await getServiceLogs(name, connection);
      return textResult(logs);
    },
  );

  // --- Get Container Logs ---
  server.tool(
    'get_container_logs',
    'Fetch container stdout/stderr logs',
    {
      id: z.string().describe('Container ID or name'),
      node: nodeParam,
      tail: z.number().optional().describe('Number of lines from the end (default 100)'),
    },
    async ({ id, node, tail }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const result = await agent.sendCommand('containerLogs', { id, tail: tail ?? 100 });
        return textResult(result);
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
      const connection = node ? await getNodeConnection(node) : undefined;
      const result = await startService(name, connection);
      return textResult(result);
    },
  );

  // --- Stop Service ---
  server.tool(
    'stop_service',
    'Stop a running service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      const result = await stopService(name, connection);
      return textResult(result);
    },
  );

  // --- Restart Service ---
  server.tool(
    'restart_service',
    'Restart a service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      const result = await restartService(name, connection);
      return textResult(result);
    },
  );

  // --- Get Service Files ---
  server.tool(
    'get_service_files',
    'Get kube YAML, compose YAML, and systemd unit files for a service',
    { name: z.string().describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      const files = await getServiceFiles(name, connection);
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
      const connection = node ? await getNodeConnection(node) : undefined;
      await deleteService(name, connection);
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
      const connection = node ? await getNodeConnection(node) : undefined;
      await renameService(oldName, newName, connection);
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

  // --- List Volumes ---
  server.tool('list_volumes', 'List volumes with usage info', { node: nodeParam }, async ({ node }) => {
    const twin = DigitalTwinStore.getInstance();
    const nodeName = await resolveNode(node);
    const volumes = twin.nodes[nodeName]?.volumes || [];
    return textResult(volumes);
  });

  // --- Create Volume ---
  server.tool(
    'create_volume',
    'Create a new podman volume',
    {
      name: z.string().describe('Volume name'),
      node: nodeParam,
    },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      await createVolume(name, undefined, connection);
      return textResult(`Volume "${name}" created successfully`);
    },
  );

  // --- Remove Volume ---
  server.tool(
    'remove_volume',
    'Remove a podman volume',
    {
      name: z.string().describe('Volume name'),
      node: nodeParam,
    },
    async ({ name, node }) => {
      const connection = node ? await getNodeConnection(node) : undefined;
      await removeVolume(name, connection);
      return textResult(`Volume "${name}" removed successfully`);
    },
  );

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
      const connection = node ? await getNodeConnection(node) : undefined;
      const logs = await getPodmanLogs(connection);
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

  return server;
}
