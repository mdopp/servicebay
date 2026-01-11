import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { NodeFactory } from './factory';
import { ServiceManager } from '../services/ServiceManager';
import { listNodes, PodmanConnection } from '../nodes';
import { getConfig } from '../config';
import { NetworkStore } from './store';
import { checkDomains, resolveHostname } from './dns';
import os from 'os';
import watcher from '../watcher';
import { DigitalTwinStore } from '../store/twin'; // Import Twin Store
import { logger } from '../logger';

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
                // Find a node that hosts this IP and exposes port 53
                const targetNode = allNodes.find(n => {
                    // Check if node has this IP
                    const hasIP = n.metadata?.nodeIPs?.includes(dnsIP) || n.ip === dnsIP;
                    if (!hasIP) return false;

                    // Check if node exposes port 53
                    // Ports can be number or {host, container}
                    const rawPorts = n.rawData?.ports || [];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const exposesDNS = rawPorts.some((p: any) => {
                        const hostPort = typeof p === 'object' ? p.host : p;
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
                }
            }
        }
    }

    // 3. Add Manual Edges (Global)
    const manualEdges = await NetworkStore.getEdges();
    for (const edge of manualEdges) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const port = (edge as any).port;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let enrichedResult: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let services: any[];

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
        const containers = twinNode.containers;
        const inspects = containers.map(c => ({
            Id: c.id,
            State: { 
                // Use 'pid' field if added to agent, or fallback to 0. 
                // Note: We recently added 'pid' to Agent V4.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                Pid: (c as any).pid || 0,
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
                 }, {} as Record<string, any>)
            }
        }));
        
        enrichedResult = [containers, inspects];
        
    } else {
         // If twin exists but not ready
         // V4.2 Robustness: Instead of throwing and breaking the whole graph, return empty graph
         // This allows other nodes to render while this one connects.
         logger.warn('NetworkService', `Digital Twin data not ready for ${nodeName} (Connected: ${twinNode.connected}, Synced: ${twinNode.initialSyncComplete}). Returning empty graph for this node.`);
         return { nodes: [], edges: [] };
    }

    const nodeIPs = nodeIPsResult;
    // getEnrichedContainers returns [containers, inspects]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const containers = (enrichedResult as any)[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const containerInspections = (enrichedResult as any)[1];

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hostPortsMap = new Map<number, any[]>();
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containers.forEach((c: any) => {
        const state = c.state || c.State;
        if (state !== 'running') return;
        
        const id = c.id || c.Id;
        const inspect = inspectMap.get(id);
        const ports = c.ports || c.Ports;

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
    // fallback to sorting/guessing ONLY if the flag is missing (for safety)
    const proxyService = services.find((s: any) => s.isPrimaryProxy) || services
        .filter(s => s.isReverseProxy)
        .sort((a, b) => {
             // 1. Sort by Active State (Active first)
             if (a.active && !b.active) return -1;
             if (!a.active && b.active) return 1;
             
             // 2. Sort by Name Preference (nginx, nginx-web preferred)
             const standards = ['nginx', 'nginx-web', 'traefik', 'caddy'];
             const isStandardA = standards.includes(a.name);
             const isStandardB = standards.includes(b.name);
             if (isStandardA && !isStandardB) return -1;
             if (!isStandardA && isStandardB) return 1;
             
             return 0;
        })[0];

    // If we found a proxy, its name is THE Truth.
    const proxyServiceName = proxyService?.name || 'nginx-web';

    logger.info('NetworkService', `Scanning ${nodeName} for proxy service: "${proxyServiceName}" (Active: ${proxyService?.active}). Found ${containers.length} containers.`);

    // Nginx Config (Only relevant if Nginx is running on this node)
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Checking Nginx config...`, node: nodeName });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nginxContainer = containers.find((c: any) => {
        // 1. Check for explicit role label (Best)
        if (c.Labels && c.Labels['servicebay.role'] === 'reverse-proxy') return true;

        // 2. Check if it belongs to the proxy service (Pod or App label)
        if (c.Labels && (
            c.Labels['io.kubernetes.pod.name'] === proxyServiceName ||
            c.Labels['io.podman.pod.name'] === proxyServiceName ||
            c.Labels['app'] === proxyServiceName
        )) return true;

        // 3. Check Name (Exact, Pod-derived, or Kube-generated)
        // e.g. service 'nginx-web' -> container 'nginx-web-nginx' or 'nginx-web'
        if (c.Names && c.Names.some((n: string) => {
            const name = n.startsWith('/') ? n.slice(1) : n;
            
            // Standard naming
            if (name === proxyServiceName || 
                name.startsWith(`${proxyServiceName}-`) || 
                name === `systemd-${proxyServiceName}`) return true;

            // Podman Kube naming (k8s_<container>_<pod>_...)
            if (name.startsWith('k8s_')) {
                const parts = name.split('_');
                // parts[1] is containerName, parts[2] is podName
                if (parts.length >= 3) {
                     // Check if container name or pod name matches the service
                     return parts[1] === proxyServiceName || parts[2] === proxyServiceName;
                }
            }

            return false;
        })) return true;

        return false;
    });

    let nginxConfig = { servers: [] as any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    let verifiedDomains: string[] = [];
    const containerUrlMapping = new Map<string, Set<string>>();

    // V4.1: Prioritize Twin Data Enrichment (Single Source of Truth)
    // The DigitalTwinStore now constructs the 'proxyConfiguration' directly on the service object.
    const agentProxyRoutes = (twinNode as any)?.proxy; // Keep for legacy check
    
    // Check if we have an authoritative proxy service with Enriched Config
    if (proxyService && proxyService.proxyConfiguration) {
         logger.info('NetworkService', `Using Enriched Nginx routes from TwinStore for ${nodeName}`);
         nginxConfig = proxyService.proxyConfiguration;
         
         // Verify Domains
         try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
         } catch (e) {
             console.warn(`[NetworkService] Failed to check domains via Enriched Twin data`, e);
         }
    } else if (agentProxyRoutes && agentProxyRoutes.length > 0) {
        // Fallback: Manually construct if not enriched (should not happen with new TwinStore)
        logger.info('NetworkService', `Using Agent-provided Nginx routes for ${nodeName} (${agentProxyRoutes.length} routes) [Legacy Path]`);
        
        nginxConfig = {
            servers: agentProxyRoutes.map((r: any) => ({
                server_name: [r.host], 
                listen: r.ssl ? ['443 ssl', '80'] : ['80'],
                locations: [{
                    path: '/',
                    proxy_pass: typeof r.targetService === 'string' && r.targetService.startsWith('http') ? r.targetService : `http://${r.targetService}`
                }],
                _agent_data: true,
                _ssl: r.ssl,
                _targetPort: r.targetPort || 80
            }))
        };
        
        try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
        } catch(e) { /* ignore */ }
    } else if (nginxContainer) {
        logger.warn('NetworkService', `Nginx container found on ${nodeName} but no Agent proxy data available. Skipping legacy SSH introspection.`);
    }

    // 1. Nginx Node (Per Server)
    const nginxId = prefix('group-nginx'); // Combined Group & Node
    // const nginxGroupId = prefix('group-nginx'); // Removed
    
    // Only add Nginx node if we found the container or it's expected
    if (nginxContainer || proxyService) {
        // STRICT: Use NodeFactory & Single Source of Truth
        let proxyRawData: any;

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
                active: nginxContainer ? (nginxContainer.State === 'running') : true
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                let finalPorts: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

                if (service.ports && service.ports.length > 0) {
                    finalPorts = service.ports.map((p: any) => ({
                         host: p.host_port || p.hostPort,
                         container: p.container_port || p.containerPort,
                         host_ip: p.host_ip || p.hostIp,
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
        const effectiveHostNetwork = service.effectiveHostNetwork || service.hostNetwork || false;
        
        let servicePorts: any[] = [];
        
        if (service.ports && service.ports.length > 0) {
             servicePorts = service.ports.map((p: any) => ({
                 host: p.host_port || p.hostPort,
                 container: p.container_port || p.containerPort,
                 host_ip: p.host_ip || p.hostIp || '0.0.0.0', // Standardize
                 protocol: p.protocol || 'tcp'
             }));
        }

        // NEW: Get Linked Containers from Twin Store Property (Single Source of Truth)
        // STRICT: No fallbacks. Uses DigitalTwin matching logic.
        const linkedContainerIds: string[] = (service as any).associatedContainerIds || [];
        const linkedContainers = linkedContainerIds.length > 0
            ? containers.filter((c: any) => linkedContainerIds.includes(c.id || c.Id))
            : [];
            
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
        m.enabled && nodeIPs.includes(m.internalClient)
    ) || [];

    // Iterate over all services/nodes on this machine
    for (const targetNode of nodes) {
        // Skip non-services or things without ports
        if (!targetNode.rawData || !targetNode.rawData.ports) continue;
        
        // Strict Type for ports w/ Bind IP check
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targetPortObjs = targetNode.rawData.ports.map((p: any) => {
            if (typeof p === 'number') return { host: p, host_ip: '0.0.0.0' };
            return p;
        });

        // 3a. Check Port Forwardings
        // We filter out any mappings where the target service is bound strictly to loopback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matchingMappings = relevantMappings.filter((m: any) => {
            // Find corresponding port on the container/service side
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const matchingPort = targetPortObjs.find((p: any) => p.host === m.internalPort);
            
            if (!matchingPort) return false;
            
            // CRITICAL: If service listens ONLY on localhost (127.0.0.1, ::1), Gateway cannot reach it.
            // Explicitly exclude these edges to ensure "node that it started from" routing logic.
            if (matchingPort.host_ip && (matchingPort.host_ip.startsWith('127.') || matchingPort.host_ip === '::1')) {
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
                        const targetHost = urlMatch[2];
                        const targetPort = urlMatch[3] ? parseInt(urlMatch[3], 10) : (urlMatch[1] === 'https://' ? 443 : 80);
                        
                        let internalPort = 0;
                        let podId: string | undefined;
                        let podName: string | undefined;
                        let targetContainer = null;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        let containerWithMapping: any = null;

                        // 0. Check if targetHost is a container IP
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const containerByIP = containers.find((c: any) => {
                            if (!c.Networks) return false;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const networks = Object.values(c.Networks) as any[];
                            return networks.some(n => n.IPAddress === targetHost);
                        });

                        if (containerByIP) {
                            targetContainer = containerByIP;
                            internalPort = targetPort;
                            podId = containerByIP.Pod;
                            podName = containerByIP.PodName || containerByIP.Labels?.['io.podman.pod.name'] || containerByIP.Labels?.['io.kubernetes.pod.name'];
                        } else {
                            // 1. Find the port mapping (HostPort -> ContainerPort)
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            containerWithMapping = containers.find((c: any) => {
                                if (!c.Ports) return false;
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                return c.Ports.some((p: any) => {
                                    const hostPort = parseInt(p.HostPort || p.host_port || '0', 10);
                                    return hostPort === targetPort;
                                });
                            });

                            if (containerWithMapping) {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const mapping = containerWithMapping.Ports.find((p: any) => {
                                    const hostPort = parseInt(p.HostPort || p.host_port || '0', 10);
                                    return hostPort === targetPort;
                                });
                                if (mapping) {
                                    internalPort = parseInt(mapping.ContainerPort || mapping.container_port || '0', 10);
                                    podId = containerWithMapping.Pod;
                                    podName = containerWithMapping.PodName || containerWithMapping.Labels?.['io.podman.pod.name'] || containerWithMapping.Labels?.['io.kubernetes.pod.name'];
                                }
                            }
                        }

                        if (internalPort > 0 && !targetContainer) {
                            // 2. Find the container that exposes this internal port
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            targetContainer = containers.find((c: any) => {
                                // If we are in a pod, check only containers in that pod
                                if (podId && c.Pod !== podId) return false;
                                // If not in a pod, check only the container with mapping
                                if (!podId && c.Id !== containerWithMapping?.Id) return false;

                                // 1. Check Enriched/Dynamic ExposedPorts (from ss)
                                if (c.ExposedPorts) {
                                    const exposed = Object.keys(c.ExposedPorts);
                                    if (exposed.some(p => parseInt(p.split('/')[0], 10) === internalPort)) return true;
                                }

                                // 2. Check Static Inspect Config
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const inspection = containerInspections.find((i: any) => i.Id.startsWith(c.Id) || c.Id.startsWith(i.Id));
                                if (inspection?.Config?.ExposedPorts) {
                                    const exposed = Object.keys(inspection.Config.ExposedPorts);
                                    if (exposed.some(p => parseInt(p.split('/')[0], 10) === internalPort)) return true;
                                }
                                return false;
                            });
                        }

                        // 3. Check for Host Network Containers (if target is local and no container found yet)
                        if (!targetContainer) {
                             const isLocalTarget = ['localhost', '127.0.0.1', '::1'].includes(targetHost) || nodeIPs.includes(targetHost);
                             
                             if (isLocalTarget) {
                                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                 targetContainer = containers.find((c: any) => {
                                     // Check for Host Network
                                     let isHost = c.IsHostNetwork || c.NetworkMode === 'host';
                                     // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                     const inspection = containerInspections.find((i: any) => i.Id.startsWith(c.Id) || c.Id.startsWith(i.Id));
                                     
                                     if (!isHost && inspection) {
                                         isHost = inspection.HostConfig?.NetworkMode === 'host' || !!inspection.NetworkSettings?.Networks?.['host'];
                                     }
                                     
                                     if (!isHost) return false;
                                     
                                     // Check Exposed Ports (Dynamic & Static)
                                     const portsToCheck = new Set<string>();
                                     if (c.ExposedPorts) Object.keys(c.ExposedPorts).forEach(p => portsToCheck.add(p));
                                     if (inspection?.Config?.ExposedPorts) Object.keys(inspection.Config.ExposedPorts).forEach(p => portsToCheck.add(p));
                                     
                                     // NEW: Check dynamic/runtime ports from Agent V4
                                     if (c.ports) {
                                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                         c.ports.forEach((p: any) => {
                                             if (p.host_port) portsToCheck.add(`${p.host_port}/tcp`);
                                         });
                                     } 
                                     if (c.Ports) {
                                         // Legacy or alternate casing
                                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                         c.Ports.forEach((p: any) => {
                                             if (p.HostPort) portsToCheck.add(`${p.HostPort}/tcp`);
                                         });
                                     }
                                     
                                     return Array.from(portsToCheck).some(p => parseInt(p.split('/')[0], 10) === targetPort);
                                 });
                             }
                        }

                        let targetId = targetContainer ? prefix(targetContainer.Id) : null;

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

                        // Fallback to Virtual Node if no Container/Pod found
                        // NEW LOGIC: Treat localhost as a real node on the current machine, not self-reference to Nginx.
                        if (!targetId && targetHost) {
                            
                            const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(targetHost);
                            const isLocalIP = nodeIPs.includes(targetHost);
                            
                            if (isLoopback || isLocalIP) {
                                // It IS a local service, just not found in containers
                                // Create a "Local Service" node visually inside the Node
                                const type = 'service';
                                targetId = prefix(`local-svc-${targetHost}-${targetPort}`);
                                
                                if (!nodes.find(n => n.id === targetId)) {
                                    // Create Virtual Node
                                    const missingNode: any = {
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
                                            targetUrl: `http://${targetHost}:${targetPort}`
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
                                        verifiedDomains: [],
                                        expectedTarget: `Host: ${targetHost}, Port: ${targetPort} (External)`
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
    }


    // 5. Containers
    for (const container of containers) {
        if (!container || (!container.Id && (!container.Names || container.Names.length === 0))) continue;
        
        // Robust Infra Detection
        const isInfra = container.isInfra || 
                        container.Image?.includes('podman-pause') || 
                        container.Names?.some((n: string) => n.includes('-infra'));
                        
        if (isInfra) continue; // Skip Infra containers in Graph

        const containerId = prefix(container.Id);
        const isProxy = (container.Labels && container.Labels['servicebay.role'] === 'reverse-proxy') ||
                        (container.Names && container.Names.some((n: string) => n.includes('/nginx-web') || n.includes('/nginx')));

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                nginxNode.status = container.State === 'running' ? 'up' : 'down';
                if (nginxNode.metadata) {
                    nginxNode.metadata.containerId = container.Id;
                    nginxNode.metadata.image = container.Image;
                }
            }
            // Don't add separate container node for proxy
        }

        const containerName = container.Names[0].replace(/^\//, '');

        if (!nodes.find(n => n.id === containerId) && !isProxy) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inspection = containerInspections.find((i: any) => i.Id.startsWith(container.Id) || container.Id.startsWith(i.Id));
            
            // Get exposed ports (Internal)
            let exposedPorts = inspection?.Config?.ExposedPorts ? Object.keys(inspection.Config.ExposedPorts) : [];
            let portMappings = container.Ports || [];

            // Check if this container is valid for dynamic port detection
            const inspect = inspectMap.get(container.Id);
            const isHostNet = (inspect?.HostConfig?.NetworkMode === 'host') || 
                              (container.Labels && container.Labels['io.podman.network.mode'] === 'host');
            // If it's a host network container, try to find dynamic ports
            if (isHostNet && inspect?.State?.Pid) {
                 const pid = inspect.State.Pid;
                 if (hostPortsMap.has(pid)) {
                     const realPorts = hostPortsMap.get(pid)!;
                     console.log(`[NetworkService] Using dynamic host ports for Container ${containerName}:`, realPorts.map(p => p.host_port).join(', '));
                     
                     // Overwrite port mappings
                     portMappings = realPorts;
                     
                     // Overwrite exposed ports for consistency
                     exposedPorts = realPorts.map(p => `${p.host_port}/${p.protocol || 'tcp'}`);
                 } 
                 // REMOVED: Fallback to service check (Relied on getContainerForService)
                 // If it's not in hostPortsMap by PID, it's not dynamic port mapped. strict.
            }
            
            // If in a pod, find infra container for mappings
            
            // If in a pod, find infra container for mappings
            if (container.Pod) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const infra = containers.find((c: any) => c.Pod === container.Pod && c.Names?.some((n: string) => n.includes('-infra')));
                if (infra && infra.Ports) {
                    portMappings = infra.Ports;
                }
            }

            // Map exposed ports to host ports
             
            const ports = exposedPorts.map((portProto: string) => {
                const [portStr] = portProto.split('/');
                const port = parseInt(portStr, 10);
                
                // Find mapping
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mapping = portMappings.find((m: any) => {
                    const mContainer = parseInt(m.ContainerPort || m.container_port || '0');
                    return mContainer === port; 
                });

                if (mapping) {
                    const hostPort = parseInt(mapping.HostPort || mapping.host_port || '0');
                    // Extract host_ip from mapping (only present if dynamic/enriched or Inspect HostIp)
                    // Podman Inspect format: HostIp (string)
                    // Enriched format: host_ip (string)
                    const hostIp = mapping.host_ip || mapping.HostIp;
                    return { host: hostPort, container: port, host_ip: hostIp };
                }
                return port;
            });
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hostPort = (ports.find((p: any) => typeof p === 'object' && p.host) as any)?.host;

            let ip = null;
            if (container.Networks) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const networks = Object.values(container.Networks) as any[];
                if (networks.length > 0 && networks[0].IPAddress) {
                    ip = networks[0].IPAddress;
                }
            }

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

             
            // const inspection = containerInspections.find((i: any) => i.Id.startsWith(container.Id) || container.Id.startsWith(i.Id));
            const hostname = inspection?.Config?.Hostname || container.Id.substring(0, 12);
            let isHostNetwork = false;
            if (inspection && inspection.HostConfig && inspection.HostConfig.NetworkMode === 'host') {
                isHostNetwork = true;
            }

            // Find domains pointing to this container via Nginx edges
            // We look for edges where target == containerId and source == nginxId
            // const incomingEdges = edges.filter(e => e.target === containerId && e.source === nginxId);
            // const linkedDomains = incomingEdges.map(e => e.label).filter(l => l && !l.startsWith(':')).join(', ');
            
            const linkedUrls = Array.from(containerUrlMapping.get(containerId) || []);

            // STRICT: Use NodeFactory
            const containerRaw = {
                ...container,
                type: 'container',
                name: containerName,
                ports: ports,
                hostNetwork: isHostNetwork || (container.networks && container.networks.includes('host')),
                ip: ip, // Inject calculated IP for Factory to use
                inspection // Inject full inspection data for deep details
            };

            const containerMeta = {
                source: 'Podman (Orphan)',
                link: hostPort ? `http://${nodeHost}:${hostPort}` : null,
                containerId: container.Id,
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
        
        const podName = container.PodName || container.Labels?.['io.podman.pod.name'] || container.Labels?.['io.kubernetes.pod.name'];
        const containerName = (container.Names && container.Names.length > 0) 
                ? container.Names[0].replace(/^\//, '') 
                : (container.Id ? container.Id.substring(0, 12) : (container.name || 'unknown'));

        // Identify Parent Service
        const parentService = services.find(s => {
            if (podName && (s.name === podName || podName.includes(s.name))) return true;
            if (containerName.startsWith(s.name + '-')) return true;
            if (containerName === s.name) return true;
            return false;
        });

        // Resolve Service IDs
        let serviceGroupId: string | null = null;

        if (parentService) {
            const isProxyService = parentService.name === 'nginx' || parentService.name === 'nginx-web' || (parentService.labels && parentService.labels['servicebay.role'] === 'reverse-proxy');
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
            const typedRaw = node.rawData as any;
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
