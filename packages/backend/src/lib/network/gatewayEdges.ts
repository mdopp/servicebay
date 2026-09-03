/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Gateway → service edges: which nodes on this host the router actually
 * reaches from outside, either through an explicit port forwarding or
 * implicitly because a verified domain resolves to the gateway.
 *
 * Extracted verbatim from `service.ts` (#2740).
 */
import type { NetworkNode, NetworkEdge } from './types';
import { resolvePortNumber, type FritzPortMapping, type PortLike } from './topologyTypes';

export function appendGatewayServiceEdges(params: {
    nodes: NetworkNode[];
    edges: NetworkEdge[];
    nodeIPs: string[];
    routerId: string;
    fbStatus: { portMappings?: FritzPortMapping[] } | null | undefined;
}): void {
    const { nodes, edges, nodeIPs, routerId, fbStatus } = params;

    // We iterate ALL services to see if they are exposed via the Gateway (FritzBox)
    // Exposure logic:
    // A) Explicit Port Forwarding (FritzBox Port Mapping -> Service Host Port)
    // B) Verified Domain (DNS points to Gateway IP -> Implicitly forwarded 80/443 to Service)
    const relevantMappings: FritzPortMapping[] = fbStatus?.portMappings?.filter((m: FritzPortMapping) =>
        m.enabled !== false && // Assume enabled if undefined
        ((m.targetIp && nodeIPs.includes(m.targetIp)) || (m.internalClient && nodeIPs.includes(m.internalClient)))
    ) || [];

    // Iterate over all services/nodes on this machine
    for (const targetNode of nodes) {
        // Skip non-services or things without ports
        if (!targetNode.rawData || !targetNode.rawData.ports) continue;

        // Strict Type for ports w/ Bind IP check
        // We normalize everything to { host: number, hostIp: string } to simplify downstream checks
        const targetPortObjs = (targetNode.rawData.ports as PortLike[])
            .map((p) => {
                if (typeof p === 'number') {
                    return { host: p, hostIp: '0.0.0.0' };
                }

                const hostPort = resolvePortNumber(p.host ?? p.hostPort ?? p.port ?? p.containerPort);
                if (!hostPort) {
                    return undefined;
                }

                return {
                    host: hostPort,
                    hostIp: p.hostIp || p.ip || '0.0.0.0'
                };
            })
            .filter((entry): entry is { host: number; hostIp: string } => typeof entry?.host === 'number');

        // 3a. Check Port Forwardings
        // We filter out any mappings where the target service is bound strictly to loopback
        const matchingMappings = relevantMappings.filter((m) => {
            // STRICT IP CHECK: Does this node/container own the target IP?
            // If targetNode has a specific IP (e.g. CNI), use it. Otherwise use Node IPs.
            const nodeSpecificIP = (targetNode.rawData as any)?.ip;
            const validIPs = nodeSpecificIP ? [nodeSpecificIP] : nodeIPs;

            // If mapping has a targetIp, it MUST match one of our valid IPs
            if (m.targetIp && !validIPs.includes(m.targetIp)) {
                return false;
            }
            // If mapping has internalClient (FritzBox name), its logic is handled by 'relevantMappings'
            // above using nodeIPs roughly, but a strict IP match is safer if we have it.

            // Find corresponding port on the container/service side
            const internalPort = resolvePortNumber(m.internalPort);
            const matchingPort = internalPort ? targetPortObjs.find((p) => p.host === internalPort) : undefined;

            if (!matchingPort) return false;

            // CRITICAL: If service listens ONLY on localhost (127.0.0.1, ::1), Gateway cannot reach it.
            // Explicitly exclude these edges to ensure "node that it started from" routing logic.
            if (matchingPort.hostIp && (matchingPort.hostIp.startsWith('127.') || matchingPort.hostIp === '::1')) {
                return false;
            }

            return true;
        });

        // 3b. Check Verified Domains (Implicit 80/443)
        // Only show implicit domain edges if the gateway actually forwards to this node's IPs
        const gatewayTargetsThisNode = relevantMappings.length > 0;
        const handlesDomains = gatewayTargetsThisNode && targetNode.metadata?.verifiedDomains && (targetNode.metadata.verifiedDomains as string[]).length > 0;

        // Combine
        if (!(matchingMappings.length > 0 || handlesDomains)) continue;

        const labels = new Set<string>();
        const portValues: number[] = [];

        const addLabel = (text: string, portValue?: number) => {
            labels.add(text);
            if (typeof portValue === 'number' && Number.isFinite(portValue) && portValue > 0 && !portValues.includes(portValue)) {
                portValues.push(portValue);
            }
        };

        const getExternalPort = (mapping: FritzPortMapping) => resolvePortNumber(mapping?.externalPort ?? mapping?.hostPort ?? mapping?.port);
        const getInternalPort = (mapping: FritzPortMapping) => resolvePortNumber(mapping?.internalPort ?? mapping?.containerPort ?? mapping?.targetPort);

        // Add forwardings
        matchingMappings.forEach((m) => {
            const labelPort = getExternalPort(m) ?? getInternalPort(m);
            if (labelPort) {
                addLabel(`:${labelPort}`, labelPort);
            }
        });

        if (handlesDomains) {
            const hasPort = (targetPort: number) => matchingMappings.some((m) => {
                const ext = getExternalPort(m);
                const int = getInternalPort(m);
                return ext === targetPort || int === targetPort;
            });

            if (!hasPort(80)) addLabel(':80 (implicit)', 80);
            if (!hasPort(443)) addLabel(':443 (implicit)', 443);
        }

        if (labels.size === 0) continue;

        // Sort numeric
        const label = Array.from(labels)
            .sort((a, b) => parseInt(a.replace(':', '').replace(' (implicit)', '')) - parseInt(b.replace(':', '').replace(' (implicit)', '')))
            .join(', ');
        const firstPort = portValues[0] ?? 0;

        // Create Edge
        // Only create edge if we have actual mappings OR verified domains
        edges.push({
            id: `edge-gateway-${targetNode.id}`,
            source: routerId, // 'gateway'
            target: targetNode.id,
            label: label,
            protocol: handlesDomains ? 'https' : 'tcp',
            port: firstPort,
            state: 'active'
        });
    }
}
