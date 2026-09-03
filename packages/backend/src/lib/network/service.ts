/**
 * NetworkService — the one entry point that produces the network graph.
 *
 * This file is orchestration only: `getGraph` fans out over nodes and folds
 * the results together, `getNodeGraph` runs one host's passes in order. Every
 * pass lives in its own module next to this one (#2740):
 *
 *   twinSnapshot      → the twin's data, shaped for the passes below
 *   proxyResolution   → which service/container is the reverse proxy
 *   serviceNodes      → proxy / managed-service / unmanaged-bundle nodes
 *   gatewayEdges      → router → service edges (forwardings + domains)
 *   proxyRouteEdges   → nginx → upstream edges, incl. virtual targets
 *   containerNodes    → container nodes + the service/pod hierarchy
 *   domainAggregation → verified-domain attribution
 *   edgeSynthesis     → merge + observed / declared / inferred edges
 *   graphAssembly     → the global passes over the merged graph
 */
import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { listNodes, PodmanConnection } from '../nodes';
import { NetworkStore } from './store';
import watcher from '../watcher';
import { getNodeTwin } from '../store/repository';
import { logger } from '../logger';
import { buildGlobalInfrastructure } from './topologyAssembler';
import { suppressUbiquitousDeps } from './ubiquitousDeps';
import { anchorFloatingNodes } from './inferredEdges';
import { appendGatewayDnsEdges, appendManualEdges, sanitizeGraph } from './graphAssembly';
import { buildTwinSnapshot } from './twinSnapshot';
import { resolveProxy } from './proxyResolution';
import { buildProxyNode, buildManagedServiceNodes, buildUnmanagedBundleNodes } from './serviceNodes';
import { appendGatewayServiceEdges } from './gatewayEdges';
import { appendProxyRouteEdges } from './proxyRouteEdges';
import { buildContainerNodes, linkContainerHierarchy } from './containerNodes';
import { propagateVerifiedDomains, filterProxyNodeDomains } from './domainAggregation';
import {
    mergeDuplicateEdges,
    appendObservedEdges,
    appendDeclaredEdges,
    appendInferredEnvEdges,
} from './edgeSynthesis';

export class NetworkService {
  async getGraph(targetNode?: string): Promise<NetworkGraph> {
    // 1. Get Global Infrastructure (Internet, Router, External Links) - ONLY ONCE
    const { nodes: globalNodes, edges: globalEdges, config, fbStatus } = await buildGlobalInfrastructure();

    const allNodes: NetworkNode[] = [...globalNodes];
    const allEdges: NetworkEdge[] = [...globalEdges];

    // 2. Iterate over Nodes
    const connections = await listNodes();
    const targets: { name: string, connection?: PodmanConnection }[] = [];

    if (targetNode) {
         if (targetNode === 'Local') {
             targets.push({ name: 'Local', connection: undefined });
         } else {
             const connection = connections.find(c => c.Name === targetNode);
             if (connection) {
                 targets.push({ name: connection.Name, connection });
             }
         }
    } else {
        // Global view: Local + Configured Nodes
        targets.push({ name: 'Local', connection: undefined });
        // Filter out any "Local" entries from connections to avoid duplicates
        for (const conn of connections.filter(c => c.Name.toLowerCase() !== 'local')) {
            targets.push({ name: conn.Name, connection: conn });
        }
    }

    const allVerifiedDomains = new Set<string>();

    // Fetch all node graphs in parallel
    const nodeGraphResults = await Promise.all(
        targets.map(async (target) => {
            watcher.emit('change', {
                type: 'network-scan-progress',
                message: `Scanning node: ${target.name}`,
                node: target.name
            });

            try {
                logger.info('NetworkService', `Fetching graph for node: ${target.name}`);
                const nodeGraph = await this.getNodeGraph(target.name, target.connection, config, fbStatus);
                return { success: true as const, name: target.name, nodeGraph };
            } catch (error) {
                logger.error('NetworkService', `Failed to fetch graph for node ${target.name}:`, error);
                return { success: false as const, name: target.name, error };
            }
        })
    );

    for (const result of nodeGraphResults) {
        if (result.success) {
            result.nodeGraph.nodes.forEach(n => {
                if (n.type === 'proxy') {
                     const domains = (n.metadata?.allVerifiedDomains || n.metadata?.verifiedDomains) as string[] | undefined;
                     if (domains) {
                        domains.forEach(d => allVerifiedDomains.add(d));
                     }
                }
            });
            allNodes.push(...result.nodeGraph.nodes);
            allEdges.push(...result.nodeGraph.edges);
        } else {
            allNodes.push({
                id: `error-${result.name}`,
                type: 'service',
                label: result.name,
                subLabel: 'Connection Failed',
                status: 'down',
                metadata: {
                    source: 'System',
                    description: result.error instanceof Error ? result.error.message : String(result.error)
                }
            });
        }
    }

    // Update Router Node with all verified domains
    const routerNode = allNodes.find(n => n.id === 'gateway');
    if (routerNode && routerNode.metadata) {
        routerNode.metadata.verifiedDomains = Array.from(allVerifiedDomains);
    }

    // 2.5 Add DNS Edges (Router -> Local DNS)
    appendGatewayDnsEdges(allNodes, allEdges, fbStatus);

    // 3. Add Manual Edges (Global)
    appendManualEdges(allEdges, await NetworkStore.getEdges());

    // 4. Cleanup & Validation
    const validEdges = sanitizeGraph(allNodes, allEdges);

    // 5. Ubiquitous-dependency suppression (#1785)
    // auth (Authelia/LLDAP) and adguard (DNS) are semantic hubs: nearly
    // every service has a declared/observed edge to them. We drop those
    // hub-spoke edges and stamp `behindAuth` / `usesDns` / `ubiquitousDeps`
    // on the source nodes so the FE renders a 🔒 badge instead — the hub
    // NODES themselves and every other real edge are preserved.
    const { edges: deUbiquitousEdges, suppressed } = suppressUbiquitousDeps(allNodes, validEdges);
    if (suppressed > 0) {
      logger.info('NetworkService', `Suppressed ${suppressed} ubiquitous hub-spoke edge(s) (auth/dns) into node badges`);
    }

    // 6. Fallback anchor (#2175) — runs on the POST-suppression edge set so a
    // service node whose ONLY edge was a suppressed ubiquitous dep (e.g.
    // claude-dev→auth) now anchors to the host root (`gateway`) instead of
    // floating. Must run here in getGraph, not per-node in getNodeGraph: the
    // suppression that leaves such a node edge-less is global (#1785), so the
    // anchor decision is only correct against the final merged+suppressed
    // edges over all nodes. `anchorFloatingNodes` already skips nodes that
    // still have a surviving edge (no double-anchor) and preserves the #2175
    // anchor-edge kind/style.
    try {
      const anchors = anchorFloatingNodes(allNodes, deUbiquitousEdges, 'gateway');
      if (anchors.length > 0) {
        logger.info('NetworkService', `Anchored ${anchors.length} floating service node(s) to gateway after suppression`);
      }
      deUbiquitousEdges.push(...anchors);
    } catch (e) {
      logger.warn('NetworkService', `fallback-anchor synthesis skipped: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { nodes: allNodes, edges: deUbiquitousEdges };
  }

  // Helper: Get Graph for a specific Node (Server)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getNodeGraph(nodeName: string, connection: PodmanConnection | undefined, config: any, fbStatus: any): Promise<{ nodes: NetworkNode[], edges: NetworkEdge[] }> {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];

    // Determine Node Hostname (for links)
    let nodeHost = 'localhost';
    if (connection && connection.URI) {
        try {
            // URI format: ssh://user@hostname:port/path
            const url = new URL(connection.URI);
            nodeHost = url.hostname;
        } catch {
            // Fallback if URI parsing fails (e.g. unix socket)
            // But remote connections usually have a hostname
            nodeHost = nodeName;
        }
    }

    // Prefix IDs with nodeName to avoid collisions (except for global nodes like 'router')
    const prefix = (id: string) => (nodeName === 'local' ? id : `${nodeName}:${id}`);
    const nginxId = prefix('group-nginx'); // Combined Group & Node
    const routerId = 'gateway'; // Global ID (matches the synthetic gateway node from buildGlobalInfrastructure)

    // 0. Prepare Data for this Node — the Digital Twin is the source of truth.
    const twinNode = getNodeTwin(nodeName);
    const snapshot = buildTwinSnapshot(nodeName, twinNode, prefix);
    if (!snapshot || !twinNode) return { nodes: [], edges: [] };

    const {
        nodeIPs, services, containers, containerInspections, inspectMap,
        hostPortsMap, containerServiceOwners, unmanagedBundles,
    } = snapshot;

    const containerUrlMapping = new Map<string, Set<string>>();
    const bundleContainerOwners = new Map<string, string>();
    const bundleServiceOwners = new Map<string, string>();

    const { proxyService, proxyServiceName, nginxContainer, nginxConfig, verifiedDomains } =
        await resolveProxy({ nodeName, twinNode, services, containers, nodeIPs, fbStatus });

    // 1. Nginx Node (Per Server)
    buildProxyNode({
        nodes, nginxId, nodeName, nodeHost, nodeIPs,
        proxyService, proxyServiceName, nginxContainer, nginxConfig, verifiedDomains,
    });

    // 2. Managed Services
    buildManagedServiceNodes({
        nodes, nginxId, nodeName, nodeHost, nodeIPs, prefix,
        services, containers, proxyService, twinNode,
    });

    // 2b. Unmanaged Service Bundles (Standalone)
    buildUnmanagedBundleNodes({
        nodes, nodeName, nodeHost, nodeIPs, prefix, unmanagedBundles,
        containerUrlMapping, bundleContainerOwners, bundleServiceOwners,
    });

    // 3. Gateway -> Service Edges (Port Forwarding & Verified Domains)
    appendGatewayServiceEdges({ nodes, edges, nodeIPs, routerId, fbStatus });

    // 4. Nginx -> Containers (Only if Nginx is on this node)
    appendProxyRouteEdges({
        nodes, edges, nodeName, nodeHost, nodeIPs, prefix, nginxId,
        nginxContainer, nginxConfig, verifiedDomains, services, containers,
        proxyService, inspectMap, containerServiceOwners, unmanagedBundles,
        containerUrlMapping, config,
    });

    // 5. Containers
    buildContainerNodes({
        nodes, containers, containerInspections, inspectMap, hostPortsMap,
        containerUrlMapping, prefix, nodeName, nodeHost, nodeIPs, nginxId,
    });

    // 6. Link Services to Containers (Redesigned Hierarchy)
    linkContainerHierarchy({ nodes, services, bundleContainerOwners, prefix, nodeName, nginxId });

    // 6.5 Update All Nodes with Verified Domains
    propagateVerifiedDomains(nodes, containerUrlMapping);

    // 6.6 Filter Nginx Proxy Node Verified Domains
    filterProxyNodeDomains({ nodes, nginxId, prefix, proxyService, nginxContainer, containerUrlMapping });

    // 7. Post-Processing: Merge duplicate edges (same source/target)
    const mergedEdges = mergeDuplicateEdges(edges);

    // #505 — observed service↔service edges from the socket-flow sampler.
    await appendObservedEdges(mergedEdges, nodes, prefix);

    // #505 PR-2 — declared dependency edges from `servicebay.dependencies`.
    appendDeclaredEdges({ mergedEdges, nodes, services, twinNode, prefix });

    // #2175 — env-target inference for services that declare nothing.
    appendInferredEnvEdges({ mergedEdges, nodes, services, twinNode, prefix });

    // #2175 — the fallback-anchor pass does NOT run here. It must operate on
    // the POST-suppression edge set (a node whose only edge is a suppressible
    // ubiquitous dep — e.g. claude-dev→auth — looks "connected" at this
    // per-node stage but ends edge-less once getGraph's suppressUbiquitousDeps
    // drops that edge). anchorFloatingNodes is called in getGraph AFTER
    // suppression, over the merged+suppressed edge set (#2175 order fix).

    return { nodes, edges: mergedEdges };
  }
}
