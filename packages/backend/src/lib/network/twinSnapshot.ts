/**
 * Digital-twin → per-node working set.
 *
 * Everything `getNodeGraph` needs from the twin before it starts building
 * nodes: the node's IPs, its services and containers, the synthesised
 * inspection records (the twin pushes enriched containers, not raw podman
 * inspects), and the PID/port lookup maps derived from them.
 *
 * Extracted verbatim from `service.ts` (#2740). Returning `null` means "twin
 * not usable" — the caller renders an empty graph for that node, exactly as
 * the inline code did.
 */
import type { NodeTwin } from '../store/twin';
import type { EnrichedContainer, PortMapping, ServiceUnit } from '../agent/types';
import { logger } from '../logger';

/**
 * The podman-inspect record the twin does NOT push. The agent sends enriched
 * containers instead, so `buildTwinSnapshot` synthesises the inspect shape the
 * downstream passes have always read. Fields the synthesis cannot fill (real
 * `ExposedPorts`, CNI addresses) stay optional — readers already guard them.
 */
export interface ContainerInspection {
    Id: string;
    State: { Pid: number; Status?: string; Running: boolean };
    HostConfig: { NetworkMode: string };
    Config: { Labels?: Record<string, string>; ExposedPorts?: Record<string, unknown> };
    Name: string;
    NetworkSettings: { Networks: Record<string, object>; IPAddress?: string };
}

export interface TwinSnapshot {
    nodeIPs: string[];
    services: ServiceUnit[];
    containers: EnrichedContainer[];
    containerInspections: ContainerInspection[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inspectMap: Map<string, any>;
    containerToPid: Map<string, number>;
    hostPortsMap: Map<number, PortMapping[]>;
    containerServiceOwners: Map<string, string>;
    unmanagedBundles: NodeTwin['unmanagedBundles'];
}

export function buildTwinSnapshot(
    nodeName: string,
    twinNode: NodeTwin | undefined,
    prefix: (id: string) => string,
): TwinSnapshot | null {
    // Check if node is missing from store entirely
    if (!twinNode) {
        if (nodeName === 'Local') {
            // Implicit Local node might not be in store yet if agent hasn't connected
            logger.warn('NetworkService', `Local Agent not yet connected. Returning empty graph.`);
            return null;
        }
        // Missing non-local node is expected if config exists but agent hasn't reported in yet
        logger.warn('NetworkService', `Node ${nodeName} unknown in TwinStore. Returning empty graph.`);
        return null;
    }

    const hasContainers = twinNode.containers && twinNode.containers.length >= 0; // Allow empty array
    const useTwin = twinNode.connected || twinNode.initialSyncComplete;

    if (!(useTwin && hasContainers)) {
        // If twin exists but not ready
        // V4.2 Robustness: Instead of throwing and breaking the whole graph, return empty graph
        // This allows other nodes to render while this one connects.
        logger.warn('NetworkService', `Digital Twin data not ready for ${nodeName} (Connected: ${twinNode.connected}, Synced: ${twinNode.initialSyncComplete}). Returning empty graph for this node.`);
        return null;
    }

    // 1. IPs
    let nodeIPs: string[];
    if (twinNode.resources?.network) {
        nodeIPs = Object.values(twinNode.resources.network).flatMap(list => list.map(i => i.address)).filter(ip => !ip.startsWith('127.') && !ip.includes(':'));
    } else {
        // Fallback if network not yet pushed (older agent?)
        nodeIPs = [];
    }

    // 2. Services
    const services: ServiceUnit[] = twinNode.services;

    // 3. Containers
    // Mock the return tuple of getEnrichedContainers: [containers, inspects]
    const containers: EnrichedContainer[] = twinNode.containers;
    const containerInspections: ContainerInspection[] = containers.map(c => ({
        Id: c.id,
        State: {
            // Use 'pid' field if added to agent, or fallback to 0.
            // Note: We recently added 'pid' to Agent V4.
            Pid: c.pid || 0,
            Status: c.status,
            Running: c.state === 'running'
        },
        HostConfig: {
            // Infer network mode roughly
            NetworkMode: (c.networks && c.networks.length > 0) ? c.networks[0] : 'default'
        },
        Config: {
            Labels: c.labels
        },
        Name: c.names[0],
        NetworkSettings: {
            Networks: (c.networks || []).reduce((acc, net) => {
                acc[net] = {}; // Mock
                return acc;
            }, {} as Record<string, object>)
        }
    }));

    const containerServiceOwners = new Map<string, string>();
    services?.forEach(service => {
        (service.associatedContainerIds || []).forEach(id => {
            if (!id) return;
            containerServiceOwners.set(id, prefix(`service-${service.name}`));
        });
    });

    // PRE-PROCESSING: Host Network Ports
    // Map Inspect Data for quick lookup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspectMap = new Map<string, any>();
    containerInspections.forEach(i => inspectMap.set(i.Id, i));

    // We no longer need to manually collect host Pids here, as enriched containers already have them processed!
    // But we still need containerToPid map for service port logic below.
    const containerToPid = new Map<string, number>();

    // Collect PIDs for internal mapping (Iterate ALL containers, no guessing).
    // The `Id` fallback covers a raw podman record slipping through untouched.
    containers.forEach(c => {
        const id = c.id || (c as unknown as { Id?: string }).Id;
        if (!id) return;
        const inspect = inspectMap.get(id);
        if (inspect && inspect.State?.Pid) {
            containerToPid.set(id, inspect.State.Pid);
        }
    });

    // Populate hostPortsMap directly from enriched containers
    const hostPortsMap = new Map<number, PortMapping[]>();

    containers.forEach(c => {
        const state = c.state; // normalized in EnrichedContainer
        if (state !== 'running') return;

        const id = c.id;
        const inspect = inspectMap.get(id);
        const ports = c.ports;

        // Map PID to Ports if available (enriched via getEnrichedContainers)
        if (inspect?.State?.Pid && ports && ports.length > 0) {
            hostPortsMap.set(inspect.State.Pid, ports);

            // Ensure standalone containers are also in containerToPid if needed
            if (!containerToPid.has(id)) {
                containerToPid.set(id, inspect.State.Pid);
            }
        }
    });

    const unmanagedBundles = Array.isArray(twinNode.unmanagedBundles) ? twinNode.unmanagedBundles : [];

    return {
        nodeIPs,
        services,
        containers,
        containerInspections,
        inspectMap,
        containerToPid,
        hostPortsMap,
        containerServiceOwners,
        unmanagedBundles,
    };
}
