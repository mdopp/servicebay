/**
 * Global graph assembly — the passes `NetworkService.getGraph` runs over the
 * merged, all-nodes graph once every per-node sub-graph has been folded in.
 *
 * Extracted verbatim from `service.ts` (#2740) so the orchestration in
 * `getGraph` reads as the sequence of passes it always was. No behaviour
 * change: same order, same ids, same log lines.
 */
import type { NetworkNode, NetworkEdge } from './types';
import type { ManualEdge } from './store';
import { logger } from '../logger';
import { resolvePortNumber, type PortLike } from './topologyTypes';

/**
 * Router → local DNS resolver edges. A DNS server the gateway advertises is
 * either an existing node that publishes :53 (edge to it) or an unmanaged box
 * on the LAN (synthesise a virtual `dns-<ip>` device node plus its edge).
 */
export function appendGatewayDnsEdges(
    allNodes: NetworkNode[],
    allEdges: NetworkEdge[],
    fbStatus: { dnsServers?: string[]; internalIP?: string } | null | undefined,
): void {
    if (!fbStatus?.dnsServers) return;

    for (const dnsIP of fbStatus.dnsServers) {
        // Check if it's a local IP
        if (!(dnsIP.startsWith('192.168.') || dnsIP.startsWith('10.') || dnsIP.startsWith('172.'))) continue;

        // Skip if DNS server is the Gateway itself (Redundant Self-Reference)
        if (dnsIP === fbStatus.internalIP) continue;

        // Find a node that hosts this IP and exposes port 53
        const targetNode = allNodes.find(n => {
            // Check if node has this IP
            const hasIP = n.metadata?.nodeIPs?.includes(dnsIP) || n.ip === dnsIP;
            if (!hasIP) return false;

            // Check if node exposes port 53 (handle both PortMapping + GraphPortMapping shapes)
            const rawPorts = (n.rawData?.ports || []) as PortLike[];
            const exposesDNS = rawPorts.some(portLike => {
                const hostPort = typeof portLike === 'number'
                    ? portLike
                    : resolvePortNumber(portLike.hostPort ?? portLike.host ?? portLike.port ?? portLike.containerPort);
                return hostPort === 53;
            });

            return exposesDNS;
        });

        if (targetNode) {
            const edgeId = `edge-gateway-dns-${targetNode.id}`;
            if (!allEdges.find(e => e.id === edgeId)) {
                allEdges.push({
                    id: edgeId,
                    source: 'gateway',
                    target: targetNode.id,
                    label: 'DNS-Resolver (:53)',
                    protocol: 'udp',
                    port: 53,
                    state: 'active'
                });
            }
        } else {
            // Virtual DNS Node (Internal but Unmanaged)
            const dnsNodeId = `dns-${dnsIP}`;
            if (!allNodes.find(n => n.id === dnsNodeId)) {
                allNodes.push({
                    id: dnsNodeId,
                    type: 'device',
                    label: 'Local DNS',
                    subLabel: dnsIP,
                    status: 'up',
                    node: 'global',
                    metadata: {
                        source: 'Router DNS Settings',
                        description: `Internal DNS Server at ${dnsIP}`,
                        host: dnsIP,
                        ip: dnsIP
                    },
                    rawData: {
                        ip: dnsIP,
                        ports: [{ hostPort: 53, containerPort: 53, protocol: 'udp' }],
                        isVirtual: true
                    }
                });
            }
            // Add Edge
            const edgeId = `edge-gateway-dns-virtual-${dnsIP}`;
            if (!allEdges.find(e => e.id === edgeId)) {
                allEdges.push({
                    id: edgeId,
                    source: 'gateway',
                    target: dnsNodeId,
                    label: 'DNS-Resolver (:53)',
                    protocol: 'udp',
                    port: 53,
                    state: 'active'
                });
            }
        }
    }
}

/** Operator-drawn links from the manual-edge store, flagged `isManual`. */
export function appendManualEdges(allEdges: NetworkEdge[], manualEdges: ManualEdge[]): void {
    for (const edge of manualEdges) {
        const port = edge.port;
        const label = port ? `:${port} (manual)` : 'Manual Link';

        allEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            label: label,
            protocol: 'tcp',
            port: port || 0,
            state: 'active',
            isManual: true
        });
    }
}

/**
 * Cleanup & validation over the merged graph. Mutates `allNodes` (restores
 * orphan endpoints of manual edges, detaches missing parents, sorts by
 * hierarchy depth) and returns the edge list with dangling non-manual edges
 * dropped.
 */
export function sanitizeGraph(allNodes: NetworkNode[], allEdges: NetworkEdge[]): NetworkEdge[] {
    const nodeIds = new Set(allNodes.map(n => n.id));

    // Handle Manual Edges with missing nodes
    // Instead of removing them, we create "Missing" virtual nodes so the user can see and delete them
    for (const edge of allEdges) {
        if (edge.isManual) {
            if (!nodeIds.has(edge.source)) {
                logger.warn('NetworkService', `Restoring missing source for manual edge: ${edge.source}`);
                allNodes.push(missingNodeFor(edge.source));
                nodeIds.add(edge.source);
            }

            if (!nodeIds.has(edge.target)) {
                logger.warn('NetworkService', `Restoring missing target for manual edge: ${edge.target}`);
                allNodes.push(missingNodeFor(edge.target));
                nodeIds.add(edge.target);
            }
        }
    }

    // Filter out edges with missing source/target (Only for non-manual edges now)
    const validEdges = allEdges.filter(e => {
        if (!nodeIds.has(e.source)) return false;
        if (!nodeIds.has(e.target)) return false;
        return true;
    });

    // Validate parent nodes
    for (const node of allNodes) {
        if (node.parentNode && !nodeIds.has(node.parentNode)) {
            logger.warn('NetworkService', `Node ${node.id} has missing parent ${node.parentNode}. Detaching.`);
            node.parentNode = undefined;
            node.extent = undefined;
        }
    }

    // Sort nodes by hierarchy depth (Parents must come before children for React Flow)
    const getDepth = (node: NetworkNode, visited = new Set<string>()): number => {
        if (!node.parentNode) return 0;
        if (visited.has(node.id)) return 0; // Cycle protection
        visited.add(node.id);
        const parent = allNodes.find(n => n.id === node.parentNode);
        return parent ? getDepth(parent, visited) + 1 : 0;
    };

    allNodes.sort((a, b) => getDepth(a) - getDepth(b));

    return validEdges;
}

function missingNodeFor(id: string): NetworkNode {
    return {
        id,
        type: 'device',
        label: id.split('-').slice(1).join('.') || id, // Try to make a readable label
        subLabel: 'Missing Node',
        status: 'down',
        metadata: {
            source: 'Manual Link (Orphaned)',
            description: 'This node was manually linked but is no longer found in the network.'
        },
        rawData: {
            type: 'missing',
            isVirtual: true
        }
    };
}
