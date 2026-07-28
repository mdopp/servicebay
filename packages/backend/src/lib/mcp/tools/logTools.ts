/**
 * Log-reading MCP tools (#2384 extraction): the one `source`-discriminated
 * reader over systemd journals, container stdout/stderr, and podman's own logs.
 */
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { redactLogText } from '../redact';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

export function registerLogTools({ server }: ToolRegistration) {
  // --- Get Logs (#2324) — one read-scoped tool with a `source` discriminator ---
  // Replaces get_service_logs / get_container_logs / get_podman_logs.
  //   source='service'   → systemd journal for a whole service (the unit).
  //   source='container' → container stdout/stderr (`<service>-<app>` name).
  //   source='podman'    → raw podman daemon/system logs for the node.
  server.tool(
    'get_logs',
    'Fetch logs from one of three sources via `source`. source="service": systemd journal for a whole service (the systemd unit) — pass `name`. source="container": container stdout/stderr — pass `container` as the `<service>-<app>` name (e.g. `media-jellyfin`), resolve it via list_containers. source="podman": raw podman daemon/system logs for the node. Use `since` (Unix seconds) on subsequent service/container calls to get only newer lines for a debug-loop pattern.',
    {
      source: z.enum(['service', 'container', 'podman']).describe('Which log source to read: service (systemd unit journal), container (podman container stdout/stderr), or podman (raw podman daemon/system logs).'),
      node: nodeParam,
      name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid service name').optional().describe('Service name — required when source="service".'),
      container: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid container id').optional().describe('Container ID or `<service>-<app>` name — required when source="container".'),
      lines: z.number().int().min(1).max(10000).optional().describe('service/container: number of lines from the end (default 200).'),
      since: z.number().int().optional().describe('service/container: Unix seconds — return only entries newer than this.'),
    },
    async ({ source, node, name, container, lines, since }) => {
      const nodeName = await resolveNode(node);
      if (source === 'podman') {
        const logs = await ServiceManager.getPodmanLogs(nodeName);
        return textResult(logs);
      }
      try {
        const agent = agentManager.getAgent(nodeName);
        let command: string;
        if (source === 'service') {
          if (!name) return errorResult('source="service" requires `name` (the service name).');
          const unit = name.match(/\.(service|scope|socket|timer)$/) ? name : `${name}.service`;
          const args = [`--user`, `-u`, unit, `-n`, String(lines ?? 200), '--no-pager', '--output', 'short-iso'];
          if (since) args.push('--since', `@${since}`);
          command = `journalctl ${args.join(' ')} 2>&1`;
        } else {
          if (!container) return errorResult('source="container" requires `container` (the `<service>-<app>` name).');
          const args = [`--tail ${lines ?? 200}`, '--timestamps'];
          if (since) args.push(`--since ${since}`);
          command = `podman logs ${args.join(' ')} ${container} 2>&1`;
        }
        const result = await agent.sendCommand('exec', { command });
        return textResult({
          // Strip credentials before handing log output back to the MCP
          // client (#321) — journals/containers catch any post-deploy line
          // that prints rendered passwords plus anything dumped at startup.
          stdout: redactLogText(result.stdout ?? ''),
          exitCode: result.code,
          fetchedAt: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        return errorResult(`Error fetching ${source === 'service' ? 'service' : 'container'} logs: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
