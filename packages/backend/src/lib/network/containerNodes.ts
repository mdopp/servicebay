/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Container nodes and the service/pod hierarchy they hang off.
 *
 * Extracted verbatim from `service.ts` (#2740): section 5 builds a node per
 * non-infra container (folding the proxy container's state into the nginx node
 * instead of giving it one), section 6 decides each container's parent —
 * managed service, unmanaged bundle, standalone pod group, or nothing.
 */
import type { NetworkNode } from './types';
import type { EnrichedContainer, PortMapping, ServiceUnit } from '../agent/types';
import { NodeFactory } from './factory';
import type { ContainerInspection } from './twinSnapshot';

/** 5. Containers. */
export function buildContainerNodes(params: {
    nodes: NetworkNode[];
    containers: EnrichedContainer[];
    containerInspections: ContainerInspection[];
    inspectMap: Map<string, any>;
    hostPortsMap: Map<number, PortMapping[]>;
    containerUrlMapping: Map<string, Set<string>>;
    prefix: (id: string) => string;
    nodeName: string;
    nodeHost: string;
    nodeIPs: string[];
    nginxId: string;
}): void {
    const { nodes, containers, containerInspections, inspectMap, hostPortsMap, containerUrlMapping, prefix, nodeName, nodeHost, nodeIPs, nginxId } = params;

    for (const container of containers) {
        // Strict Accessors (Twin EnrichedContainer)
        const cId = container.id;
        const cNames = container.names || [];
        const cLabels = container.labels || {};
        const cImage = container.image;
        const cState = container.state;

        if (!cId && (!cNames || cNames.length === 0)) continue;

        // Robust Infra/Service Container Detection
        const isInfra = container.isInfra ||
            (cImage && cImage.includes('podman-pause')) ||
            (cNames.some((n: string) => n.endsWith('-infra') || n.endsWith('-service'))) ||
            (!cImage && cNames.some((n: string) => /^[0-9a-f]+-service$/.test(n)));

        if (isInfra) continue; // Skip infra/service containers in Graph

        const containerId = prefix(cId);

        const isProxy = (cLabels['servicebay.role'] === 'reverse-proxy') ||
            (cNames.some((n: string) => n.includes('/nginx')));

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                // Handle complex State object if needed (Podman Inspect)
                const isRunning = cState === 'running'; // EnrichedContainer.state is string

                nginxNode.status = isRunning ? 'up' : 'down';
                if (nginxNode.metadata) {
                    nginxNode.metadata.containerId = cId;
                    nginxNode.metadata.image = cImage;
                }
            }
            // Don't add separate container node for proxy
        }

        const containerName = (cNames.length > 0) ? cNames[0].replace(/^\//, '') : (cId.substring(0, 12));

        if (nodes.find(n => n.id === containerId) || isProxy) continue;

        const inspection = containerInspections.find(i => i.Id.startsWith(cId) || cId.startsWith(i.Id));

        // Get exposed ports (Internal)
        let exposedPorts = inspection?.Config?.ExposedPorts ? Object.keys(inspection.Config.ExposedPorts) : [];
        let portMappings = container.ports || [];

        // Check if this container is valid for dynamic port detection
        const inspect = inspectMap.get(cId);
        const isHostNet = (inspect?.HostConfig?.NetworkMode === 'host') ||
            (cLabels['io.podman.network.mode'] === 'host') ||
            (container.isHostNetwork) ||
            (container.networks && container.networks.includes('host')); // Check Twin Data

        // If it's a host network container, try to find dynamic ports
        if (isHostNet && inspect?.State?.Pid) {
            const pid = inspect.State.Pid;
            if (hostPortsMap.has(pid)) {
                const realPorts = hostPortsMap.get(pid)!;

                // Overwrite port mappings
                portMappings = realPorts;

                // Overwrite exposed ports for consistency
                exposedPorts = realPorts.map(p => `${p.hostPort}/${p.protocol || 'tcp'}`);
            }
        }

        // If in a pod, find infra container for mappings
        if (container.podId) {
            const infra = containers.find((c) => c.podId === container.podId && c.isInfra);
            if (infra) {
                portMappings = infra.ports || portMappings;
            }
        }

        // Map exposed ports to host ports
        const ports = exposedPorts.map((portProto: string) => {
            const [portStr] = portProto.split('/');
            const port = parseInt(portStr, 10);

            // Find mapping
            const mapping = portMappings.find((m) => {
                const mContainer = parseInt((m.containerPort || 0).toString());
                return mContainer === port;
            });

            if (mapping) {
                const hostPort = parseInt(String(mapping.hostPort || '0'));
                // Enriched format: hostIp
                const hostIp = mapping.hostIp;
                return { host: hostPort, container: port, hostIp: hostIp };
            }
            return port;
        });

        const hostPort = (ports.find((p: any) => typeof p === 'object' && p.host) as any)?.host;

        let ip = null;
        // EnrichedContainer has `networks: string[]` names only. No IP inside.
        // We rely on inspection data for IP fallback if available.
        if (!ip && inspection?.NetworkSettings) {
            if (inspection.NetworkSettings.IPAddress) {
                ip = inspection.NetworkSettings.IPAddress;
            } else if (inspection.NetworkSettings.Networks) {
                const networks = Object.values(inspection.NetworkSettings.Networks) as any[];
                if (networks.length > 0 && networks[0].IPAddress) {
                    ip = networks[0].IPAddress;
                }
            }
        }

        let isHostNetwork = isHostNet; // Use previously calculated

        if (!isHostNetwork && inspection && inspection.HostConfig && inspection.HostConfig.NetworkMode === 'host') {
            isHostNetwork = true;
        }

        const linkedUrls = Array.from(containerUrlMapping.get(containerId) || []);

        // STRICT: Use NodeFactory
        const containerRaw = {
            ...container,
            type: 'container',
            name: containerName,
            ports: ports,
            hostNetwork: isHostNetwork,
            ip: ip, // Inject calculated IP for Factory to use
            inspection // Inject full inspection data for deep details
        };

        const containerMeta = {
            source: 'Podman (Orphan)',
            link: hostPort ? `http://${nodeHost}:${hostPort}` : null,
            containerId: cId,
            nodeHost,
            nodeIPs,
            verifiedDomains: linkedUrls
        };

        nodes.push(NodeFactory.createContainerNode(
            containerId,
            containerRaw,
            nodeName,
            containerMeta,
            undefined
        ));
    }
}

/**
 * 6. Link Services to Containers (Redesigned Hierarchy)
 * Scenario 1: Service Group [ Service -> Pod -> Container ]
 * Scenario 2: Pod Group [ Pod -> Container ]
 * Scenario 3: Container (Standalone)
 */
export function linkContainerHierarchy(params: {
    nodes: NetworkNode[];
    services: ServiceUnit[];
    bundleContainerOwners: Map<string, string>;
    prefix: (id: string) => string;
    nodeName: string;
    nginxId: string;
}): void {
    const { nodes, services, bundleContainerOwners, prefix, nodeName, nginxId } = params;

    // We iterate a copy of container nodes to avoid modification issues during loop,
    // though we are modifying 'nodes' array (pushing groups/pods), so basic for-of is safe if filter creates new array.
    const containerNodes = nodes.filter(n => n.type === 'container' && n.node === nodeName);

    for (const node of containerNodes) {
        if (!node.rawData) continue;
        const container = node.rawData;

        const podName = container.podName || container.labels?.['io.podman.pod.name'] || container.labels?.['io.kubernetes.pod.name'];

        // Identify Parent Service
        const parentService = services.find(s => {
            // 1. Strict TwinStore Link (Single Source of Truth)
            // If the service has explicitly linked containers strings, use them.
            if (s.associatedContainerIds) {
                const ids = s.associatedContainerIds;
                if (ids.includes(container.id) || ids.some(id => container.id?.startsWith(id))) {
                    return true;
                }
            }

            return false;
        });

        // Resolve Service IDs
        let serviceGroupId: string | null = null;

        if (parentService) {
            const isProxyService = parentService.name === 'nginx' || !!parentService.isReverseProxy;
            // If proxy, parent is the Nginx Group/Node (nginxId)
            // If service, parent is the Service Group/Node
            serviceGroupId = isProxyService ? nginxId : prefix(`service-${parentService.name}`);
        }

        const bundleParentId = bundleContainerOwners.get(container.id);
        if (!serviceGroupId && bundleParentId) {
            serviceGroupId = bundleParentId;
        }

        // Add Pod info to metadata
        if (podName) {
            if (!node.metadata) node.metadata = {};
            node.metadata.pod = podName;
        }

        // Handle Placement (Hierarchy)
        // Scenario 1: Managed Service (with or without Pod)
        if (serviceGroupId) {
            node.parentNode = serviceGroupId;
            node.extent = 'parent';
            if (node.metadata) {
                node.metadata.source = (bundleParentId && serviceGroupId === bundleParentId)
                    ? 'Unmanaged Bundle'
                    : 'Managed Service';
            }

            // Note: Container is visually inside the Service Node. No explicit edge needed.
        } else if (podName) {
            // Scenario 2: Standalone Pod Group
            const podGroupId = prefix(`group-pod-${podName}`);

            // Create Group if not exists
            if (!nodes.find(n => n.id === podGroupId)) {
                nodes.push({
                    id: podGroupId,
                    type: 'pod', // Pod is a Node
                    label: podName, // Pod Group Label
                    subLabel: 'Pod Group',
                    status: 'up',
                    node: nodeName,
                    metadata: { source: 'Podman' },
                    rawData: { type: 'pod' }
                });
            }

            node.parentNode = podGroupId;
            node.extent = 'parent';
            if (node.metadata) node.metadata.source = 'Podman Pod';
            // No internal edges for Pod Group
        } else {
            // Scenario 3: Standalone Container
            // No parent
            node.parentNode = undefined;
            node.extent = undefined;
        }
    }
}
