/**
 * Global-infrastructure subgraph assembly for the network map.
 *
 * Extracted from `NetworkService.getGlobalInfrastructure` in #973 as
 * the first per-seam split. Pure data-shape work — takes the
 * Digital Twin gateway state + config + external-link bookmarks and
 * emits the always-visible "Internet → Gateway + per-link nodes"
 * triangle that every node's per-node subgraph hangs off.
 *
 * No `this` state, no class. The original method just routed through
 * the singletons; this function takes them as inputs so unit tests
 * can stub freely.
 */

import { type NetworkNode, type NetworkEdge } from './types';
import { getConfig } from '../config';
import { getGateway } from '../store/repository';
import {
  buildExternalLinkPorts,
  getExternalLinkNodeId,
  normalizeExternalTargets,
} from './externalLinks';
import { resolvePortNumber } from './topologyTypes';

export interface GlobalInfrastructure {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbStatus: any;
}

/**
 * Build the always-present Internet + Gateway + external-link triangle.
 * Called once per `NetworkService.getGraph()` invocation; the result
 * is then enriched with per-node subgraphs by the caller.
 */
export async function buildGlobalInfrastructure(): Promise<GlobalInfrastructure> {
  const nodes: NetworkNode[] = [];
  const edges: NetworkEdge[] = [];

  const config = await getConfig();

  // SSOT: Use Digital Twin Gateway State
  const gw = getGateway();

  // Map Twin State to legacy fbStatus format for compatibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalizedPortMappings = (gw.portMappings || []).map((mapping: any) => {
    const externalPort = resolvePortNumber(mapping.externalPort ?? mapping.hostPort ?? mapping.port);
    const internalPort = resolvePortNumber(mapping.internalPort ?? mapping.containerPort ?? mapping.targetPort);
    const targetIp = mapping.targetIp || mapping.internalClient || undefined;

    return {
      ...mapping,
      externalPort,
      internalPort,
      targetIp,
      internalClient: mapping.internalClient || targetIp,
    };
  });

  const fbStatus = {
    connected: gw.upstreamStatus === 'up',
    externalIP: gw.publicIp,
    internalIP: gw.internalIp,
    uptime: gw.uptime || 0,
    portMappings: normalizedPortMappings,
    dnsServers: gw.dnsServers,
    upstreamStatus: gw.upstreamStatus,
  };

  // --- Add Synthetic Nodes (Gateway, Internet) ---
  // These must ALWAYS be present in the graph for visualization
  const domain = config.domain || 'node';

  // Internet Node
  nodes.push({
    id: 'internet',
    label: 'Internet',
    type: 'internet',
    status: 'up',
    node: 'global',
    metadata: {
      host: '0.0.0.0',
      url: 'https://' + domain,
    },
  });

  // Gateway Node
  nodes.push({
    id: 'gateway',
    label: gw.provider === 'fritzbox' ? 'FritzBox Gateway' : 'Gateway',
    type: 'gateway',
    status: gw.upstreamStatus === 'up' ? 'up' : 'down',
    node: 'global',
    metadata: {
      host: config.gateway?.host || '192.168.178.1',
      url: `http://${config.gateway?.host || 'fritz.box'}`,
      stats: fbStatus,
    },
    rawData: gw, // EXPOSE RICH DATA
  });

  edges.push({
    id: 'edge-internet-gateway',
    source: 'internet',
    target: 'gateway',
    protocol: 'https',
    port: 443,
    state: 'active',
  });

  // External Links (Bookmarks)
  if (config.externalLinks) {
    for (const link of config.externalLinks) {
      const nodeId = getExternalLinkNodeId(link);
      const ipTargets = normalizeExternalTargets(link.ipTargets || []);
      const parsedPorts = buildExternalLinkPorts(ipTargets);

      let inferredPort: number | undefined = parsedPorts[0]?.host;
      if (!inferredPort && link.url) {
        try {
          const parsed = new URL(link.url);
          inferredPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
        } catch {
          inferredPort = undefined;
        }
      }

      nodes.push({
        id: nodeId,
        label: link.name,
        type: 'service',
        status: 'up',
        node: 'global',
        metadata: {
          url: link.url,
          icon: link.icon,
          description: link.description,
          isExternal: true,
          ipTargets,
        },
        rawData: {
          ...link,
          ipTargets,
          ports: parsedPorts,
        },
      });
    }
  }

  return { nodes, edges, config, fbStatus };
}
