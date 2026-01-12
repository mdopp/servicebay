import { NetworkGraph, NetworkNode, NetworkEdge, PortMapping as GraphPortMapping } from './types';
import { NodeFactory } from './factory';
import { listNodes, PodmanConnection } from '../nodes';
import { getConfig } from '../config';
import { NetworkStore } from './store';
import { checkDomains } from './dns';
import os from 'os';
import watcher from '../watcher';
import { DigitalTwinStore } from '../store/twin'; // Import Twin Store
import { logger } from '../logger';
import yaml from 'js-yaml'; // Helper: YAML parser
import { EnrichedContainer, PortMapping, ServiceUnit, WatchedFile } from '../agent/types';

interface KubePodSpec {
    spec?: {
        containers?: {
            ports?: {
                hostPort?: number;
                containerPort?: number;
                hostIp?: string;
                protocol?: string;
            }[];
        }[];
    };
}

export class NetworkService {
  private getLocalIPs(): string[] {
    const nets = os.networkInterfaces();
    const results: string[] = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]!) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (net.family === 'IPv4' && !net.internal) {
                results.push(net.address);
            }
        }
    }
    return results;
  }


  async getGraph(targetNode?: string): Promise<NetworkGraph> {
    // 1. Get Global Infrastructure (Internet, Router, External Links) - ONLY ONCE
    const { nodes: globalNodes, edges: globalEdges, config, fbStatus } = await this.getGlobalInfrastructure();
    
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
        for (const conn of connections) {
            targets.push({ name: conn.Name, connection: conn });
        }
    }
    
    const allVerifiedDomains = new Set<string>();

    for (const target of targets) {
        // Report progress via SSE
        watcher.emit('change', { 
            type: 'network-scan-progress', 
            message: `Scanning node: ${target.name}`,
            node: target.name 
        });

        try {
            console.log(`[NetworkService] Fetching graph for node: ${target.name}`);
            const nodeGraph = await this.getNodeGraph(target.name, target.connection, config, fbStatus);
            
            // Collect verified domains from Nginx nodes
            nodeGraph.nodes.forEach(n => {
                if (n.type === 'proxy') {
                     // Prefer full list (allVerifiedDomains) if available, otherwise filtered list
                     const domains = (n.metadata?.allVerifiedDomains || n.metadata?.verifiedDomains) as string[] | undefined;
                     if (domains) {
                        domains.forEach(d => allVerifiedDomains.add(d));
                     }
                }
            });

            // Merge nodes and edges
            allNodes.push(...nodeGraph.nodes);
            allEdges.push(...nodeGraph.edges);
        } catch (error) {
            console.error(`[NetworkService] Failed to fetch graph for node ${target.name}:`, error);
            // Add a visual error node?
            allNodes.push({
                id: `error-${target.name}`,
                type: 'service', // Use service shape for node representation
                label: target.name,
                subLabel: 'Connection Failed',
                status: 'down',
                metadata: {
                    source: 'System',
                    description: error instanceof Error ? error.message : String(error)
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
    if (fbStatus?.dnsServers) {
        for (const dnsIP of fbStatus.dnsServers) {
            // Check if it's a local IP
            if (dnsIP.startsWith('192.168.') || dnsIP.startsWith('10.') || dnsIP.startsWith('172.')) {
                // Skip if DNS server is the Gateway itself (Redundant Self-Reference)
                if (dnsIP === fbStatus.internalIP) continue;

                // Find a node that hosts this IP and exposes port 53
                const targetNode = allNodes.find(n => {
                    // Check if node has this IP
                    const hasIP = n.metadata?.nodeIPs?.includes(dnsIP) || n.ip === dnsIP;
                    if (!hasIP) return false;

                    // Check if node exposes port 53
                    const rawPorts = (n.rawData?.ports || []) as PortMapping[];
                    // Check mixed types: PortMapping[] or number[]
                    const exposesDNS = rawPorts.some(p => p.hostPort === 53);
                    
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
    }

    // 3. Add Manual Edges (Global)
    const manualEdges = await NetworkStore.getEdges();
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

    // 4. Cleanup & Validation
    const nodeIds = new Set(allNodes.map(n => n.id));

    // Handle Manual Edges with missing nodes
    // Instead of removing them, we create "Missing" virtual nodes so the user can see and delete them
    for (const edge of allEdges) {
        if (edge.isManual) {
            if (!nodeIds.has(edge.source)) {
                console.warn(`[NetworkService] Restoring missing source for manual edge: ${edge.source}`);
                allNodes.push({
                    id: edge.source,
                    type: 'device',
                    label: edge.source.split('-').slice(1).join('.') || edge.source, // Try to make a readable label
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
                });
                nodeIds.add(edge.source);
            }
            
            if (!nodeIds.has(edge.target)) {
                console.warn(`[NetworkService] Restoring missing target for manual edge: ${edge.target}`);
                allNodes.push({
                    id: edge.target,
                    type: 'device',
                    label: edge.target.split('-').slice(1).join('.') || edge.target,
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
                });
                nodeIds.add(edge.target);
            }
        }
    }

    // Filter out edges with missing source/target (Only for non-manual edges now)
    const validEdges = allEdges.filter(e => {
        if (!nodeIds.has(e.source)) {
            // console.warn(`[NetworkService] Removing edge ${e.id}: Source ${e.source} not found`);
            return false;
        }
        if (!nodeIds.has(e.target)) {
            // console.warn(`[NetworkService] Removing edge ${e.id}: Target ${e.target} not found`);
            return false;
        }
        return true;
    });

    // Validate parent nodes
    for (const node of allNodes) {
        if (node.parentNode && !nodeIds.has(node.parentNode)) {
            console.warn(`[NetworkService] Node ${node.id} has missing parent ${node.parentNode}. Detaching.`);
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

    return { nodes: allNodes, edges: validEdges };
  }

  // Helper: Get Global Infrastructure (Internet, Router)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getGlobalInfrastructure(): Promise<{ nodes: NetworkNode[], edges: NetworkEdge[], config: any, fbStatus: any }> {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];
    
    const config = await getConfig();
    
    // SSOT: Use Digital Twin Gateway State
    const twin = DigitalTwinStore.getInstance();
    const gw = twin.gateway;

    // Map Twin State to legacy fbStatus format for compatibility
    const fbStatus = {
        connected: gw.upstreamStatus === 'up',
        externalIP: gw.publicIp,
        internalIP: gw.internalIp,
        uptime: gw.uptime || 0,
        portMappings: gw.portMappings || [],
        dnsServers: gw.dnsServers,
        upstreamStatus: gw.upstreamStatus
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
        url: 'https://' + domain
      }
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
        stats: fbStatus
      },
      rawData: gw // EXPOSE RICH DATA
    });

    edges.push({
      id: 'edge-internet-gateway',
      source: 'internet',
      target: 'gateway',
      protocol: 'https',
      port: 443,
      state: 'active'
    });
    
    // External Links (Bookmarks)
    if (config.externalLinks) {
        for (const link of config.externalLinks) {
            nodes.push({
                id: `ext-${link.name}`,
                label: link.name,
                type: 'service',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                status: 'active' as any,
                node: 'global',
                metadata: {
                    url: link.url,
                    icon: link.icon,
                    description: link.description,
                    isExternal: true
                }
            });
            // If they are local LAN links, connect to Gateway? Or just floating?
            // Usually connected to Gateway/LAN
            edges.push({
                id: `edge-gateway-ext-${link.name}`,
                source: 'gateway',
                target: `ext-${link.name}`,
                protocol: 'http',
                port: 80,
                state: 'active'
            });
        }
    }

    return { nodes, edges, config, fbStatus };
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
    const routerId = 'gateway'; // Global ID (Matched with getGlobalInfrastructure)

    // 0. Prepare Data for this Node
    
    // Check Digital Twin first
    const twinNode = DigitalTwinStore.getInstance().nodes[nodeName];
    // We consider twin usable if it has basic data. 
    // Agent V4 pushes 'containers' and 'services'.
    
    // Check if node is missing from store entirely
    if (!twinNode) {
         if (nodeName === 'Local') {
             // Implicit Local node might not be in store yet if agent hasn't connected
             logger.warn('NetworkService', `Local Agent not yet connected. Returning empty graph.`);
             return { nodes: [], edges: [] };
         }
         // Missing non-local node is expected if config exists but agent hasn't reported in yet
         logger.warn('NetworkService', `Node ${nodeName} unknown in TwinStore. Returning empty graph.`);
         return { nodes: [], edges: [] };
    }

    const hasContainers = twinNode.containers && twinNode.containers.length >= 0; // Allow empty array
    const useTwin = twinNode.connected || twinNode.initialSyncComplete;

    let nodeIPsResult: string[];
    // We strictly use the EnrichedContainer and ServiceUnit types from the Twin
    let services: ServiceUnit[];
    let containers: EnrichedContainer[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let containerInspections: any[];

    if (useTwin && hasContainers) {
        // console.log(`[NetworkService] Using Digital Twin data for ${nodeName}`);
        
        // 1. IPs
        if (twinNode.resources?.network) {
            nodeIPsResult = Object.values(twinNode.resources.network).flatMap(list => list.map(i => i.address)).filter(ip => !ip.startsWith('127.') && !ip.includes(':'));
        } else {
             // Fallback if network not yet pushed (older agent?)
             nodeIPsResult = []; 
        }

        // 2. Services
        services = twinNode.services;

        // 3. Containers
        // Mock the return tuple of getEnrichedContainers: [containers, inspects]
        containers = twinNode.containers;
        containerInspections = containers.map(c => ({
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
        
    } else {
         // If twin exists but not ready
         // V4.2 Robustness: Instead of throwing and breaking the whole graph, return empty graph
         // This allows other nodes to render while this one connects.
         logger.warn('NetworkService', `Digital Twin data not ready for ${nodeName} (Connected: ${twinNode.connected}, Synced: ${twinNode.initialSyncComplete}). Returning empty graph for this node.`);
         return { nodes: [], edges: [] };
    }

    const nodeIPs = nodeIPsResult;
    // getEnrichedContainers returns [containers, inspects]
    // The lists are already populated above

    // PRE-PROCESSING: Host Network Ports
    // Map Inspect Data for quick lookup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspectMap = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containerInspections.forEach((i: any) => inspectMap.set(i.Id, i));

    // We no longer need to manually collect host Pids here, as enriched containers already have them processed!
    // But we still need containerToPid map for service port logic below.
     
    const containerToPid = new Map<string, number>();

    // Collect PIDs for internal mapping (Iterate ALL containers, no guessing)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containers.forEach((c: any) => {
         const id = c.id || c.Id;
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
    
    // Find the Reverse Proxy Service
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Analyzing services...`, node: nodeName });
    
    // Improved Selection Logic: Use the Authoritative Flag from TwinStore
    // The DigitalTwinStore already performs the logic to identify the primary proxy (isPrimaryProxy).
    // It also links associated containers to services.
    const proxyService = services.find(s => s.isPrimaryProxy);

    // If we found a proxy, its name is THE Truth.
    const proxyServiceName = proxyService?.name || 'nginx-web';

    // logger.info('NetworkService', `Scanning ${nodeName} for proxy service: "${proxyServiceName}" (Active: ${proxyService?.active}). Found ${containers.length} containers.`);

    // Nginx Config (Only relevant if Nginx is running on this node)
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Checking Nginx config...`, node: nodeName });

    // Use associated containers from the authoritative proxy service
    let nginxContainer: EnrichedContainer | undefined;

    if (proxyService && proxyService.associatedContainerIds && proxyService.associatedContainerIds.length > 0) {
        // Find the first container that exists in our current list
        nginxContainer = containers.find(c => proxyService.associatedContainerIds?.includes(c.id));
    } else {
        // Fallback checks for unmanaged setups or missed associations
         nginxContainer = containers.find(c => {
            const labels = c.labels || {};
            // 1. Check for explicit role label
            if (labels['servicebay.role'] === 'reverse-proxy') return true;

            return false;
        });
    }

    let nginxConfig = { servers: [] as any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    let verifiedDomains: string[] = [];
    const containerUrlMapping = new Map<string, Set<string>>();

    // V4.1: Prioritize Twin Data Enrichment (Single Source of Truth)
    // The DigitalTwinStore now constructs the 'proxyConfiguration' directly on the service object.
    const agentProxyRoutes = twinNode.proxy; // Keep for legacy check
    
    // Check if we have an authoritative proxy service with Enriched Config
    if (proxyService && proxyService.proxyConfiguration) {
         // logger.info('NetworkService', `Using Enriched Nginx routes from TwinStore for ${nodeName}`);
         nginxConfig = proxyService.proxyConfiguration as typeof nginxConfig;
         
         // Verify Domains
         try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
         } catch (e) {
             console.warn(`[NetworkService] Failed to check domains via Enriched Twin data`, e);
         }
    } else if (agentProxyRoutes && agentProxyRoutes.length > 0) {
        // Fallback: Manually construct if not enriched (should not happen with new TwinStore)
        // logger.info('NetworkService', `Using Agent-provided Nginx routes for ${nodeName} (${agentProxyRoutes.length} routes) [Legacy Path]`);
        
        nginxConfig = {
            servers: agentProxyRoutes.map((r) => {
                let targetService = typeof r.targetService === 'string' && r.targetService.startsWith('http') ? r.targetService : `http://${r.targetService}`;
                 // Fixed: Ensure port is included (Same fix as TwinStore)
                 if (r.targetPort && !targetService.includes(`:${r.targetPort}`)) {
                      if (!/:\d+(\/|$)/.test(targetService)) {
                          targetService = `${targetService}:${r.targetPort}`;
                      }
                 }

                return {
                    server_name: [r.host], 
                    listen: r.ssl ? ['443 ssl', '80'] : ['80'],
                    locations: [{
                        path: '/',
                        proxy_pass: targetService
                    }],
                    _agent_data: true,
                    _ssl: r.ssl,
                    _targetPort: r.targetPort || 80
                };
            })
        };
        
        try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
        } catch { /* ignore */ }
    } else if (nginxContainer) {
        logger.warn('NetworkService', `Nginx container found on ${nodeName} but no Agent proxy data available. Skipping legacy SSH introspection.`);
    }

    // 1. Nginx Node (Per Server)
    const nginxId = prefix('group-nginx'); // Combined Group & Node
    // const nginxGroupId = prefix('group-nginx'); // Removed
    
    // Only add Nginx node if we found the container or it's expected
    if (nginxContainer || proxyService) {
        // STRICT: Use NodeFactory & Single Source of Truth
        let proxyRawData: Record<string, unknown>;

        if (proxyService) {
             // 1. Preferred: Use Digital Twin Service Object directly
             // We strictly trust the Twin's 'ports', 'active', and 'proxyConfiguration'
             proxyRawData = {
                 ...proxyService,
                 verifiedDomains,
                 type: 'gateway' // Visual Override
             };
        } else {
             // 2. Fallback: Unmanaged/Legacy Container (No Service Twin)
             proxyRawData = {
                ...nginxConfig, // Spreads { servers: ... }
                verifiedDomains,
                ports: nginxContainer?.ports || [], // Discovery: Use container ports (no hardcoding)
                type: 'gateway',
                name: proxyServiceName,
                active: nginxContainer ? (nginxContainer.state === 'running') : true
             };
        }
        
        const proxyMeta = {
             link: null,
             verifiedDomains,
             nodeHost,
             nodeIPs
        };

        nodes.push(NodeFactory.createProxyNode(nginxId, proxyRawData, nodeName, proxyMeta));
    }

    // 2. Managed Services
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Processing services & ports...`, node: nodeName });
    for (const service of services) {
        const isProxy = service === proxyService;

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                nginxNode.status = service.active ? 'up' : 'down';
                if (nginxNode.metadata) {
                    nginxNode.metadata.serviceDescription = service.description;
                }

                // Inject full service details into rawData (Flattened)
                if (nginxNode.rawData) {
                    // Start with the existing Raw Data (Gateway properties)
                    const existingData = { ...nginxNode.rawData };
                    
                    // Flatten: Merge service properties onto top level, but preserve Gateway-specifics
                    // We prioritize existingData (servers, type=gateway) over service props
                     
                    nginxNode.rawData = { ...service, ...existingData };
                    
                    // Explicitly cleanup if service object was somehow spread weirdly
                    // (Not needed if we trust the spread, but just to be sure we don't have nested 'service' key)
                    if ('service' in nginxNode.rawData) {
                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                         delete (nginxNode.rawData as any).service;
                    }

                    // Cleanup redundant 'servers' legacy field if we have the modern 'proxyConfiguration'
                    // This reduces noise in the Raw Data view
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if ((nginxNode.rawData as any).proxyConfiguration && (nginxNode.rawData as any).servers) {
                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                         delete (nginxNode.rawData as any).servers;
                    }
                }
                
                // Determine Ports: Use Single Source of Truth (TwinStore Enrichment)
                let finalPorts: GraphPortMapping[] = [];

                if (service.ports && service.ports.length > 0) {
                    finalPorts = service.ports.map(p => ({
                         host: p.hostPort || 0,
                         container: p.containerPort || 0,
                         hostIp: p.hostIp,
                         protocol: p.protocol || 'tcp'
                     }));
                }

                if (finalPorts.length > 0) {
                    if (nginxNode.rawData) {
                       nginxNode.rawData.ports = finalPorts;
                    }
                }
                continue;
            }
        }

        const serviceGroupId = prefix(`service-${service.name}`);

        // Prepare ports for service node (USE TWIN SOURCE OF TRUTH)
        const effectiveHostNetwork = service.effectiveHostNetwork || (service as { hostNetwork?: boolean }).hostNetwork || false;
        
        let servicePorts: GraphPortMapping[] = [];
        
        if (service.ports && service.ports.length > 0) {
             servicePorts = service.ports.map(p => ({
                 host: p.hostPort || 0,
                 container: p.containerPort || 0,
                 hostIp: p.hostIp || '0.0.0.0', // Standardize
                 protocol: p.protocol || 'tcp'
             }));
        }

        // Fallback: Parse Quadlet File for Ports if service is inactive/missing ports
        // This ensures the graph shows the intended architecture even if the service is down.
        if (servicePorts.length === 0 && twinNode.files) {
             // Heuristic: Look for definitions matching the service name
             const candidates = Object.values(twinNode.files).filter((f: WatchedFile) => 
                f.path.includes(`/${service.name}.yml`) || // Kube YAML
                f.path.includes(`/${service.name}.container`) // Container Unit
             );

             for (const file of candidates) {
                 if (file.path.endsWith('.yml') || file.path.endsWith('.yaml')) {
                     try {
                         const content = yaml.load(file.content) as KubePodSpec;
                         // Kube Pod Spec
                         const kubeContainers = content.spec?.containers || [];
                         kubeContainers.forEach((c) => {
                             if (c.ports) {
                                 c.ports.forEach((kp) => {
                                     // Kube: hostPort, containerPort
                                     if (kp.hostPort) {
                                         servicePorts.push({
                                             host: kp.hostPort,
                                             container: kp.containerPort || 0,
                                             hostIp: '0.0.0.0', // Definition implies all interfaces usually
                                             protocol: kp.protocol?.toLowerCase() || 'tcp',
                                             source: 'definition' // Flag as static definition
                                         });
                                     }
                                 });
                             }
                         });
                     } catch (err) {
                         logger.warn('NetworkService', `Failed to parse Quadlet YAML for ${service.name}: ${err}`);
                     }
                 } else if (file.path.endsWith('.container')) {
                     // Simple INI Parsing for [Container] PublishPort=...
                     const lines = file.content.split('\n');
                     lines.forEach((line: string) => {
                         const match = line.match(/^PublishPort=(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):)?(\d+):(\d+)(?:\/(udp|tcp))?/);
                         if (match) {
                             // [1]=IP(opt), [2]=Host, [3]=Container, [4]=Proto(opt)
                             servicePorts.push({
                                 host: parseInt(match[2], 10),
                                 container: parseInt(match[3], 10),
                                 hostIp: match[1] || '0.0.0.0',
                                 protocol: match[4] || 'tcp',
                                 source: 'definition'
                             });
                         } else {
                             // Handle implicit host-only format? "PublishPort=8080" -> 8080:8080?
                             // Systemd supports multiple formats.
                         }
                     });
                 }
             }
        }

        // NEW: Get Linked Containers from Twin Store Property (Single Source of Truth)
        // STRICT: No fallbacks to heuristics. We rely solely on the Digital Twin.
        const linkedContainerIds: string[] = service.associatedContainerIds || [];
        const linkedContainers = containers.filter((c) => linkedContainerIds.includes(c.id));

        // REMOVED: Redundant Host Network & Dynamic Port Calculation Logic
        // This is now done in DigitalTwinStore.enrichNode()

        // Enrich Raw Data with more context (Container, File/Quadlet)
        // Use the list of linked containers instead of singular activeContainer
        // const activeContainer = getContainerForService(service.name);
        
        // Find Quadlet file path (from Service Unit path or search)
        // ServiceUnit has 'path'. We can try to find the source file in files cache if needed.
        // For now, let's just inject what we have.
        
        // Create Service Node (Merged Group & Node)
        // STRICT: Use NodeFactory to enforce RawData derivation
        const serviceRawData = {
            ...service,
            // Inject full digital twin context
            containers: linkedContainers, // New: Multi-container support
            ports: servicePorts, // STRICT: Ensure RawData reflects the actual calculated/runtime ports
            type: 'service',
            hostNetwork: effectiveHostNetwork
        };

        const serviceMetadata = {
            source: 'Systemd/Podman',
            description: service.description,
            link: null,
            nodeHost,
            nodeIPs
        };

        nodes.push(NodeFactory.createServiceNode(serviceGroupId, serviceRawData, nodeName, serviceMetadata));
    }

    // 3. Gateway -> Service Edges (Port Forwarding & Verified Domains)
    // We iterate ALL services to see if they are exposed via the Gateway (FritzBox)
    // Exposure logic:
    // A) Explicit Port Forwarding (FritzBox Port Mapping -> Service Host Port)
    // B) Verified Domain (DNS points to Gateway IP -> Implicitly forwarded 80/443 to Service)
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relevantMappings = fbStatus?.portMappings?.filter((m: any) => 
        m.enabled !== false && // Assume enabled if undefined
        ( (m.targetIp && nodeIPs.includes(m.targetIp)) || (m.internalClient && nodeIPs.includes(m.internalClient)) )
    ) || [];

    // Iterate over all services/nodes on this machine
    for (const targetNode of nodes) {
        // Skip non-services or things without ports
        if (!targetNode.rawData || !targetNode.rawData.ports) continue;
        
        // Strict Type for ports w/ Bind IP check
        // We normalize everything to { host: number, hostIp: string } to simplify downstream checks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targetPortObjs = targetNode.rawData.ports.map((p: any) => {
            if (typeof p === 'number') return { host: p, hostIp: '0.0.0.0' };
            return { host: p.hostPort, hostIp: p.hostIp || '0.0.0.0' };
        });

        // 3a. Check Port Forwardings
        // We filter out any mappings where the target service is bound strictly to loopback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matchingMappings = relevantMappings.filter((m: any) => {
            // STRICT IP CHECK: Does this node/container own the target IP?
            // If targetNode has a specific IP (e.g. CNI), use it. Otherwise use Node IPs.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nodeSpecificIP = (targetNode.rawData as any)?.ip;
            const validIPs = nodeSpecificIP ? [nodeSpecificIP] : nodeIPs;
            
            // If mapping has a targetIp, it MUST match one of our valid IPs
            if (m.targetIp && !validIPs.includes(m.targetIp)) {
                 return false;
            }
            // If mapping has internalClient (FritzBox name), it logic is handled by 'relevantMappings' filter up top using nodeIPs roughly,
            // but strict IP match is safer if we have it.

            // Find corresponding port on the container/service side
            const matchingPort = targetPortObjs.find((p: { host: number; }) => p.host === m.internalPort);
            
            if (!matchingPort) return false;
            
            // CRITICAL: If service listens ONLY on localhost (127.0.0.1, ::1), Gateway cannot reach it.
            // Explicitly exclude these edges to ensure "node that it started from" routing logic.
            if (matchingPort.hostIp && (matchingPort.hostIp.startsWith('127.') || matchingPort.hostIp === '::1')) {
                return false;
            }
            
            return true;
        });
        
        // 3b. Check Verified Domains (Implicit 80/443)
        // If this node handles verified domains, IT IS the target for HTTP traffic
        // This is primarily for Nginx/Proxy, but could apply to any service handling domains
        const handlesDomains = targetNode.metadata?.verifiedDomains && (targetNode.metadata.verifiedDomains as string[]).length > 0;
        
        // Combine
        if (matchingMappings.length > 0 || handlesDomains) {
                const labels = new Set<string>();
                
                // Add forwardings
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                matchingMappings.forEach((m:any) => labels.add(`:${m.externalPort}`));
                
                if (handlesDomains) {
                    // Only imply 80/443 if matching mappings confirm it OR strictly if the node exposes them (0.0.0.0)
                    // Users want correct "associated with ports" logic.
                    // Ideally, we should check if 80/443 are actually mapped.
                    // But if UPnP or "Exposed Host" is used, specific mappings might be missing.
                    // Compatibility: If logic assumes 80/443 are open, just label them.
                    
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const has80 = matchingMappings.some((m:any) => m.externalPort === 80);
                     // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const has443 = matchingMappings.some((m:any) => m.externalPort === 443);
                    
                    // If strictly strict, we would only add labels if (has80 || has443).
                    // But currently we add them implicitly.
                    if (!has80) labels.add(':80 (implicit)');
                    if (!has443) labels.add(':443 (implicit)');
                }

                if (labels.size === 0) continue;

                // Sort numeric
                const label = Array.from(labels)
                    .sort((a,b) => parseInt(a.replace(':','').replace(' (implicit)', '')) - parseInt(b.replace(':','').replace(' (implicit)', '')))
                    .join(', ');
                
                // Create Edge
                // Only create edge if we have actual mappings OR verified domains
                // (And if handlesDomains is true, ensure we aren't bound to localhost logic wise - handled by checkDomains usually)
                edges.push({
                id: `edge-gateway-${targetNode.id}`,
                source: routerId, // 'gateway'
                target: targetNode.id,
                label: label,
                protocol: handlesDomains ? 'https' : 'tcp',
                port: 0, // Visual only
                state: 'active'
            });
        }
    }

    // 4. Nginx -> Containers (Only if Nginx is on this node)
    if (nginxContainer) { 
        for (const server of nginxConfig.servers) {
            // Find verified domains for this server block
            const serverDomains = server.server_name.filter((name: string) => verifiedDomains.includes(name));
            
            for (const loc of server.locations) {
                // Prioritize explicit structured data from Twin Store
                let targetHost: string | undefined;
                let targetPort = 80;
                let isDirect = false;

                // Support both casing styles (TwinStore vs raw Agent)
                const vFields = server.variable_fields || server.variableFields;

                if (vFields) {
                    targetHost = vFields.targetHost || vFields.variable_target_host;
                    targetPort = vFields.targetPort || vFields.variable_target_port || 80;
                    isDirect = true;
                }

                if (!isDirect) {
                    let proxyPass = loc.proxy_pass;

                    // Fallback: Use variables if proxy_pass is missing but variables exist (Nginx Proxy Manager style)
                    if (!proxyPass && server.variables?.['$server'] && server.variables?.['$port']) {
                        const scheme = server.variables['$forward_scheme'] || 'http';
                        const host = server.variables['$server'];
                        const port = server.variables['$port'];
                        proxyPass = `${scheme}://${host}:${port}`;
                    }

                    if (proxyPass) {
                        // Extract target from proxy_pass (e.g. http://127.0.0.1:8080)
                        // We need to handle full URLs to detect external targets
                        const urlMatch = proxyPass.match(/^(https?:\/\/)?([^:/]+)(?::(\d+))?/);
                        
                        if (urlMatch) {
                            targetHost = urlMatch[2];
                            targetPort = urlMatch[3] ? parseInt(urlMatch[3], 10) : (urlMatch[1] === 'https://' ? 443 : 80);
                        }
                    }
                }
                
                if (targetHost) {
                        let internalPort = 0;
                        let podId: string | undefined;
                        let podName: string | undefined;
                        let targetContainer = null;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        let containerWithMapping: any = null;

                        // 0. Check if targetHost is a container IP, Name, or Service Name
                        const containerByIPOrName = containers.find((c) => {
                            // A) IP Check - Robust against CIDR/Subnet masks
                            if (c.networks && c.networks.length > 0) {
                                // In Digital Twin, networks is string[], but IP might be in enriched structure? 
                                // Actually EnrichedContainer doesn't have IP list directly yet?
                                // Wait, `getEnrichedContainers` mocks inspection.
                                // But `c` here is EnrichedContainer.
                                // We might need to check if we can match against IP.
                                // Assuming we don't have IPs easily on EnrichedContainer yet (it has ports).
                                // But wait, let's check EnrichedContainer def again.
                                // It has `networks: string[]`.
                                // It does NOT have explicit IPs. 
                                // We rely on name/service match mainly for now.
                                return false; 
                            }
                            // B) Name Check (Docker internal DNS)
                            // Clean names (remove /)
                            const names = (c.names || []).map((n) => n.replace(/^\//, ''));
                            if (names.some((n) => n === targetHost || n.includes(targetHost))) return true;

                            // C) Service Name / Label Check
                            if (c.labels) {
                                if (c.labels['com.docker.compose.service'] === targetHost) return true;
                                if (c.labels['io.kubernetes.pod.name'] === targetHost) return true;
                                if (c.labels['app'] === targetHost) return true;
                            }

                            return false;
                        });

                        if (containerByIPOrName) {
                            targetContainer = containerByIPOrName;
                            // If we matched by Name/Service, the port in proxy_pass matches the internal Container Port (usually)
                            // or the service port.
                            // If it was IP match, it matches internal IP port.
                            // So usually internalPort = targetPort.
                            internalPort = targetPort;
                            
                            podId = containerByIPOrName.podId;
                            podName = containerByIPOrName.podName || containerByIPOrName.labels?.['io.podman.pod.name'] || containerByIPOrName.labels?.['io.kubernetes.pod.name'];
                        } else {
                            // 1. Find via Host Port Mapping (if target is Host IP/Localhost)
                            // Only valid if targetHost implies "This Node"
                            const isSelf = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(targetHost) || nodeIPs.includes(targetHost);
                            
                            if (isSelf) {
                                 
                                containerWithMapping = containers.find((c) => {
                                    // Check Runtime Ports or Config Ports
                                    const ports = c.ports || [];
                                    
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const matchRuntime = ports.some((p: any) => parseInt(p.hostPort, 10) === targetPort);
                                    
                                    return matchRuntime;
                                });

                                if (containerWithMapping) {
                                    // Resolve internal port from mapping
                                    const ports = containerWithMapping.ports || []; 
                                    
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const mapping = ports.find((p: any) => parseInt(p.hostPort, 10) === targetPort);

                                    if (mapping) {
                                        internalPort = parseInt(mapping.containerPort || '0', 10);
                                    } else {
                                        internalPort = targetPort; // Fallback
                                    }
                                    
                                    podId = containerWithMapping.podId;
                                    podName = containerWithMapping.podName || containerWithMapping.labels?.['io.podman.pod.name'] || containerWithMapping.labels?.['io.kubernetes.pod.name'];
                                }
                            }
                        }

                        if (internalPort > 0 && !targetContainer) {
                            // 2. Find the container that exposes this internal port
                             
                            targetContainer = containers.find((c) => {
                                // If we are in a pod, check only containers in that pod
                                if (podId && c.podId !== podId) return false;
                                // If not in a pod, check only the container with mapping
                                if (!podId && c.id !== containerWithMapping?.id) return false;

                                // 1. Check Enriched/Dynamic ExposedPorts (Need inspection mock or proper enrichment)
                                // EnrichedContainer doesn't have exposed ports list yet, only mapped ports.
                                // We might need to assume true if mapping exists for now.
                                return false;

                                // 2. Check Static Inspect Config
                                // We need access to inspection data here if we want to check exposed ports.
                                // But c is EnrichedContainer.
                                // The inspection map exists: inspectMap
                            });
                            
                            // Retry with proper map lookup
                             targetContainer = containers.find((c) => {
                                if (podId && c.podId !== podId) return false;
                                if (!podId && c.id !== containerWithMapping?.id) return false;
                                
                                const inspect = inspectMap.get(c.id);
                                if (inspect?.Config?.ExposedPorts) {
                                    const exposed = Object.keys(inspect.Config.ExposedPorts);
                                    if (exposed.some(p => parseInt(p.split('/')[0], 10) === internalPort)) return true;
                                }
                                return false;
                            })
                        }

                        // 3. Check for Host Network Containers (if target is local and no container found yet)
                        if (!targetContainer) {
                             const isLocalTarget = ['localhost', '127.0.0.1', '::1'].includes(targetHost) || nodeIPs.includes(targetHost);
                             
                             if (isLocalTarget) {
                                  
                                 targetContainer = containers.find((c) => {
                                     const inspect = inspectMap.get(c.id);
                                     
                                     // Check for Host Network: Enriched Property + Inspection fallback
                                     let isHost = c.isHostNetwork || (c.networks && c.networks.includes('host'));
                                     if (!isHost && inspect) {
                                         isHost = inspect.HostConfig?.NetworkMode === 'host' || !!inspect.NetworkSettings?.Networks?.['host'];
                                     }
                                     
                                     if (!isHost) return false;
                                     
                                     // Check Exposed Ports (Dynamic & Static)
                                     const portsToCheck = new Set<string>();
                                     // c.ExposedPorts does not exist on EnrichedContainer.
                                     if (inspect?.Config?.ExposedPorts) Object.keys(inspect.Config.ExposedPorts).forEach(p => portsToCheck.add(p));
                                     
                                     // NEW: Check dynamic/runtime ports from Agent V4
                                     if (c.ports) {
                                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                         c.ports.forEach((p: any) => {
                                             if (p.hostPort) portsToCheck.add(`${p.hostPort}/tcp`);
                                         });
                                     } 
                                     
                                     return Array.from(portsToCheck).some(p => parseInt(p.split('/')[0], 10) === targetPort);
                                 });
                             }
                        }

                        let targetId = targetContainer ? prefix(targetContainer.id) : null;

                        // Fallback to Pod if no container found but we have a pod
                        if (!targetId && podName) {
                             targetId = prefix(`pod-${podName}`);
                        }

                        // 4. Check External Links (IP Targets)
                        if (!targetId && config.externalLinks) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const matchedLink = config.externalLinks.find((l: any) => 
                                l.ip_targets && (
                                    l.ip_targets.includes(`${targetHost}:${targetPort}`) || 
                                    l.ip_targets.includes(targetHost) // Allow just IP match? simpler.
                                )
                            );
                            if (matchedLink) {
                                targetId = `link-${matchedLink.id}`; // Global ID (no prefix)
                            }
                        }

                        // NEW: Before creating a generic External Node, check if this target IS known in the Nginx Configuration
                        // but maybe we just missed it in the Twin's Proxy list.
                        // Actually, if we are iterating nginxConfig.servers, we ARE looking at the configuration.
                        // The user says "based on the ip... which need to be added to the proxyConfiguration.servers in the digital twin".
                        // This implies the DigitalTwin might have incomplete info? 
                        // But wait, we iterate `nginxConfig` which COMES from `proxyService.proxyConfiguration`.
                        // If it's already there (we found `targetHost`), we just need to ensure we use it.

                        // Problem likely: We fail to create a node if "External Links" logic above fails?
                        // No, the fallback below creates a Virtual Node.

                        // Maybe the "Virtual Node" creation is skipped for some reason?
                        // Condition: `if (!targetId && targetHost)`
                        
                        // Debug log to trace why edges might not appear
                        // console.log(`[GraphDebug] Processing Nginx upstream: ${targetHost}:${targetPort} -> TargetID: ${targetId || 'NONE'}`);

                        // Fallback to Virtual Node if no Container/Pod found
                        // NEW LOGIC: Treat localhost as a real node on the current machine, not self-reference to Nginx.
                        if (!targetId && targetHost) {
                            
                            const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(targetHost);
                            const isLocalIP = nodeIPs.includes(targetHost);
                            
                            if (isLoopback || isLocalIP) {
                                // It IS a local service, just not found in containers
                                // Create a "Local Service" node visually inside the Node
                                targetId = prefix(`local-svc-${targetHost}-${targetPort}`);
                                
                                if (!nodes.find(n => n.id === targetId)) {
                                    // Create Virtual Node
                                    const missingNode: NetworkNode = {
                                        id: targetId,
                                        type: 'service', // Use service shape to look integrated
                                        label: `:${targetPort}`,
                                        subLabel: 'Internal Service',
                                        status: 'down', // Warning state (unmanaged or hidden)
                                        node: nodeName, // Important: Belong to this Node group
                                        metadata: {
                                            source: 'Nginx Proxy',
                                            description: `Nginx forwards to ${targetHost}:${targetPort}, but no managed container was found.`,
                                            verifiedDomains: serverDomains, // Inherit domains so we see what routes here
                                            targetUrl: `http://${targetHost}:${targetPort}`,
                                            // Actionable: Flag as potentially needing configuration
                                            isMissingService: true
                                        },
                                        rawData: {
                                            type: 'virtual-service',
                                            name: `Local Service ${targetPort}`,
                                            active: false,
                                            ports: [{ host: targetPort, protocol: 'tcp' }]
                                        }
                                    };
                                    nodes.push(missingNode);
                                }

                            } else {
                                // External
                                const type = 'external';
                                targetId = prefix(`${type}-${targetHost}-${targetPort}`);
                                
                                if (!nodes.find(n => n.id === targetId)) {
                                    // STRICT: Use NodeFactory
                                    const deviceRaw = {
                                        type: 'device',
                                        name: targetHost,
                                        ip: targetHost,
                                        ports: [targetPort],
                                        isVirtual: true,
                                        // Specific visual props injected into raw
                                        subLabel: `External (${targetPort})`,
                                        active: true
                                    };

                                    const deviceMeta = {
                                        source: 'Nginx Proxy',
                                        description: `External Service detected via Nginx configuration.`,
                                        link: `http://${targetHost}:${targetPort}`,
                                        nodeHost,
                                        verifiedDomains: serverDomains || [], // Include domains routed here
                                        expectedTarget: `Host: ${targetHost}, Port: ${targetPort} (External)`,
                                        // Actionable: Allow creating external link
                                        isExternalMissing: true,
                                        externalTargetIp: targetHost,
                                        externalTargetPort: targetPort
                                    };

                                    nodes.push(NodeFactory.createDeviceNode(targetId, deviceRaw, nodeName, deviceMeta));
                                }
                            }
                        }

                        if (targetId) {
                            // Add edge
                            const edgeId = `edge-nginx-${targetId}-${targetPort}`;
                            if (!edges.find(e => e.id === edgeId)) {
                                edges.push({
                                    id: edgeId,
                                    source: nginxId,
                                    target: targetId,
                                    label: `:${targetPort}`,
                                    protocol: 'http',
                                    port: targetPort,
                                    state: 'active'
                                });
                            }

                            // Add URLs to mapping
                            if (!containerUrlMapping.has(targetId)) {
                                containerUrlMapping.set(targetId, new Set());
                            }
                            const urlSet = containerUrlMapping.get(targetId)!;
                            
                            for (const domain of serverDomains) {
                                // Construct URL: http(s)://domain/path
                                // Check if ssl is enabled for this server
                                const isSsl = server.listen.some((l: string) => l.includes('443') || l.includes('ssl'));
                                const protocol = isSsl ? 'https' : 'http';
                                const path = loc.path === '/' ? '' : loc.path;
                                urlSet.add(`${protocol}://${domain}${path}`);
                            }
                        }
                    }
                }
            }
        }
    
    // 5. Containers
    for (const container of containers) {
        // Strict Accessors (Twin EnrichedContainer)
        const cId = container.id;
        const cNames = container.names || [];
        const cLabels = container.labels || {};
        const cImage = container.image;
        const cState = container.state;
        
        if (!cId && (!cNames || cNames.length === 0)) continue;
        
        // Robust Infra Detection
        const isInfra = container.isInfra || 
                        (cImage && cImage.includes('podman-pause')) || 
                        (cNames.some((n: string) => n.includes('-infra')));
                        
        if (isInfra) continue; // Skip Infra containers in Graph

        const containerId = prefix(cId);
        
        const isProxy = (cLabels['servicebay.role'] === 'reverse-proxy') ||
                        (cNames.some((n: string) => n.includes('/nginx-web') || n.includes('/nginx')));

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

        if (!nodes.find(n => n.id === containerId) && !isProxy) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inspection = containerInspections.find((i: any) => i.Id.startsWith(cId) || cId.startsWith(i.Id));
            
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
                     // console.log(`[NetworkService] Using dynamic host ports for Container ${containerName}:`, realPorts.map(p => p.hostPort).join(', '));
                     
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
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hostPort = (ports.find((p: any) => typeof p === 'object' && p.host) as any)?.host;

            let ip = null;
            // EnrichedContainer has `networks: string[]` names only. No IP inside.
            // We rely on inspection data for IP fallback if available.
            // Or look for a new `ips` property if we add it to EnrichedContainer in future.
            
            // Fallback to inspection data if IP is missing
            if (!ip && inspection?.NetworkSettings) {
                if (inspection.NetworkSettings.IPAddress) {
                    ip = inspection.NetworkSettings.IPAddress;
                } else if (inspection.NetworkSettings.Networks) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const networks = Object.values(inspection.NetworkSettings.Networks) as any[];
                    if (networks.length > 0 && networks[0].IPAddress) {
                        ip = networks[0].IPAddress;
                    }
                }
            }

             
            // const hostname = inspection?.Config?.Hostname || cId.substring(0, 12);
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
                isProxy ? nginxId : undefined
            ));
        }
    }

    // 6. Link Services to Containers (Redesigned Hierarchy)
    // Scenario 1: Service Group [ Service -> Pod -> Container ]
    // Scenario 2: Pod Group [ Pod -> Container ]
    // Scenario 3: Container (Standalone)

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
            const isProxyService = parentService.name === 'nginx' || parentService.name === 'nginx-web' || !!parentService.isReverseProxy;
            // If proxy, parent is the Nginx Group/Node (nginxId)
            // If service, parent is the Service Group/Node
            serviceGroupId = isProxyService ? nginxId : prefix(`service-${parentService.name}`);
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
            if (node.metadata) node.metadata.source = 'Managed Service';
            
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


    // 6.5 Update All Nodes with Verified Domains (Virtual, Container, and Service Groups)
    // Run this loop multiple times (or better, process from leaves up) to ensure propagation
    // For now, simple child lookup is enough as we only have depth 1 (Service -> Container) or depth 2 (Service -> Pod -> Container)
    
    // First, map container IDs to verified domains (already done via containerUrlMapping)
    
    // Second, propagate to Service Groups (which are parents of containers)
    // We need to iterate over all nodes because Service Groups might be created before or after containers in the array
    
    for (const node of nodes) {
        if (!node.metadata) node.metadata = {};
        
        // 1. Direct mapping (Virtual or Container Nodes)
        const directUrls = containerUrlMapping.get(node.id);
        const linkedUrls = new Set(directUrls || []);

        // V4.1: Inject Verified Domains from TwinStore (Source of Truth)
        if (node.rawData) {
            // Check ServiceUnit or EnrichedContainer
            const typedRaw = node.rawData as { verifiedDomains?: string[] };
            if (typedRaw.verifiedDomains && Array.isArray(typedRaw.verifiedDomains)) {
                 (typedRaw.verifiedDomains as string[]).forEach(d => linkedUrls.add(d));
            }
        }
        
        // 2. Child aggregation (Service Nodes containing Containers)
        // Find children of this node
        const children = nodes.filter(n => n.parentNode === node.id);
        
        children.forEach(child => {
             // 2a. Direct Child (Container)
             const childUrls = containerUrlMapping.get(child.id);
             if (childUrls) childUrls.forEach(u => linkedUrls.add(u));
             
             // 2b. Grandchild (Pod -> Container), only if this node is a Service Group parent of a Pod Group
             // (Though currently structure is flattened: Service Group -> Container, or Pod Group -> Container)
             // But if a container is in a pod, does it have parentNode=PodGroup?
             // Logic above: 
             // if (serviceGroupId) node.parentNode = serviceGroupId;
             // else if (podName) node.parentNode = podGroupId;
             
             // So Service Group -> Container is direct.
             // Pod Group -> Container is direct.
             
             // Note: If a service manages a pod, do we interpret it correctly?
             // The code sets parentNode = serviceGroupId if service exists. So Pod Group is ignored/not used as parent?
             // Yes: "Container is visually inside the Service Node."
             
             // If child also has metadata.verifiedDomains (e.g. set by container logic above), use that too
             if (child.metadata?.verifiedDomains) {
                 (child.metadata.verifiedDomains as string[]).forEach(d => linkedUrls.add(d));
             }
        });

        if (linkedUrls.size > 0) {
            node.metadata.verifiedDomains = Array.from(linkedUrls);
        }
    }

    // 6.6 Filter Nginx Proxy Node Verified Domains
    // We only want to show domains that are naturally handled by Nginx itself (e.g. static sites)
    // and NOT domains that are proxied to other containers/services, to avoid duplication.
    const nginxNode = nodes.find(n => n.id === nginxId);
    if (nginxNode && nginxNode.metadata && nginxNode.metadata.verifiedDomains) {
        // Store full list of domains for Router/Gateway
        nginxNode.metadata.allVerifiedDomains = [...(nginxNode.metadata.verifiedDomains as string[])];

        const domainsMappedToOthers = new Set<string>();
        for (const [targetId, urls] of containerUrlMapping.entries()) {
            if (targetId === nginxId) continue; // Don't exclude domains explicitly mapped to Nginx
            for (const url of urls) {
                try {
                    const u = new URL(url);
                    domainsMappedToOthers.add(u.hostname);
                } catch {
                    // Ignore invalid URLs
                }
            }
        }
        
        nginxNode.metadata.verifiedDomains = (nginxNode.metadata.verifiedDomains as string[])
            .filter(d => !domainsMappedToOthers.has(d));
    }

    // 7. Post-Processing: Merge duplicate edges (same source/target)
    // This cleans up the graph by combining multiple port connections into a single edge
    const mergedEdges: NetworkEdge[] = [];
    const edgeMap = new Map<string, NetworkEdge[]>();

    edges.forEach(edge => {
        const key = `${edge.source}|${edge.target}`;
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key)!.push(edge);
    });

    edgeMap.forEach((group) => {
        if (group.length === 1) {
            mergedEdges.push(group[0]);
        } else {
            const primary = group[0];
            const labels = Array.from(new Set(group.map(e => e.label))).filter(Boolean).sort().join(', ');
            
            mergedEdges.push({
                ...primary,
                id: `merged-${primary.source}-${primary.target}`,
                label: labels,
                // Use the first port as primary, or null/0 if mixed? 
                // The graph logic mainly uses 'label' for display.
                port: primary.port 
            });
        }
    });

    return { nodes, edges: mergedEdges };
  }
}
