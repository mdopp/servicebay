/**
 * Node-level MCP tools (#2384 extraction): node inventory, host resources,
 * topology, agent control, the self-diagnose entry point, the shell escape
 * hatch, and the ServiceBay release channel the box runs on.
 */
import { z } from 'zod';
import { getStoreSnapshot, getNodeTwin } from '@/lib/store/repository';
import { getAllSystemServices } from '@/lib/manager';
import { listNodes, getNodeConnection } from '@/lib/nodes';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { agentManager } from '@/lib/agent/manager';
import { getServicebayChannel, setServicebayChannel } from '@/lib/servicebayChannel';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerNodeTools({ server }: ToolRegistration) {
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

  // --- Get Gateway Status ---
  server.tool('get_gateway_status', 'Get gateway info: public IP, port mappings, uptime', {}, async () => {
    return textResult(getStoreSnapshot().gateway);
  });

  // --- Exec Command ---
  server.tool(
    'exec_command',
    'LAST RESORT — run an arbitrary shell command on a node. It is a destructive-op escape hatch: calling it fires a destructive-op alert + an auto-snapshot, even for a harmless read. Reach for a read tool FIRST; only use exec_command when NO dedicated/read tool covers the task. Read-alternatives map: image / revision / state → list_containers (labels org.opencontainers.image.revision, org.opencontainers.image.version); container logs → get_logs(source="container"), service/unit logs → get_logs(source="service"); CPU / RAM / disk / uptime → get_system_info; read a file → read_file, a service\'s files → get_service_files; list services / containers → list_services / list_containers.',
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
}
