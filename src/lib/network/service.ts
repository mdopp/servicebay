import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { FritzBoxClient } from '../fritzbox/client';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static fbStatusCache: { data: any, timestamp: number } | null = null;

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
                ports: [],
                metadata: {
                    source: 'System',
                    description: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    // Update Router Node with all verified domains
    const routerNode = allNodes.find(n => n.id === 'router');
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
                    const exposesDNS = n.ports.some(p => {
                        const hostPort = typeof p === 'object' ? p.host : p;
                        return hostPort === 53;
                    });
                    
                    return exposesDNS;
                });

                if (targetNode) {
                    const edgeId = `edge-router-dns-${targetNode.id}`;
                    if (!allEdges.find(e => e.id === edgeId)) {
                        allEdges.push({
                            id: edgeId,
                            source: 'router',
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
                    ports: [],
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
                    ports: [],
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
    
    // FritzBox Status
    let fbClient: FritzBoxClient;
    if (config.gateway?.type === 'fritzbox') {
        fbClient = new FritzBoxClient({
            host: config.gateway.host,
            username: config.gateway.username,
            password: config.gateway.password
        });
    } else {
        fbClient = new FritzBoxClient();
    }

    let fbStatus = null;
    
    // Check Cache (TTL 60s)
    if (NetworkService.fbStatusCache && (Date.now() - NetworkService.fbStatusCache.timestamp < 60000)) {
        fbStatus = NetworkService.fbStatusCache.data;
    } else {
        try {
            fbStatus = await fbClient.getStatus();
            // Cache it
            NetworkService.fbStatusCache = { data: fbStatus, timestamp: Date.now() };
        } catch (e) {
            console.warn('[NetworkService] Failed to fetch FritzBox status, using offline mockup', e);
            fbStatus = {
                connected: false,
                ip: 'Offline',
                uptime: 0,
                bytesIn: 0,
                bytesOut: 0,
                maxDown: 0,
                maxUp: 0
            };
        }
    }

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
      ports: [],
      metadata: {
        host: '0.0.0.0',
        url: 'https://' + domain
      }
    });

    // Gateway Node
    nodes.push({
      id: 'gateway',
      label: 'Gateway',
      type: 'gateway',
      status: fbStatus?.upstreamStatus === 'up' ? 'up' : 'down',
      node: 'global',
      ports: [],
      metadata: {
        host: config.gateway?.host || '192.168.178.1',
        url: `http://${config.gateway?.host || 'fritz.box'}`,
        stats: fbStatus
      }
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
                ports: [],
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
    const routerId = 'router'; // Global ID

    // 0. Prepare Data for this Node
    
    // Check Digital Twin first
    const twinNode = DigitalTwinStore.getInstance().nodes[nodeName];
    // We consider twin usable if it has basic data. 
    // Agent V4 pushes 'containers' and 'services'.
    
    // Check if node is missing from store entirely
    if (!twinNode) {
         if (nodeName === 'Local') {
             // Implicit Local node might not be in store yet if agent hasn't connected
             throw new Error(`Local Agent not yet connected.`);
         }
         throw new Error(`Node ${nodeName} unknown or not connected.`);
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
         throw new Error(`Digital Twin data not ready for ${nodeName} (Connected: ${twinNode.connected}, Synced: ${twinNode.initialSyncComplete})`);
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

    // Helper to find the main container for a service
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getContainerForService = (serviceName: string): any | undefined => {
        // 1. Check for explicit role label
        // 2. Check PODMAN_SYSTEMD_UNIT
        // 3. Check Names
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const found = containers.find((c: any) => {
            if (c.Labels?.['PODMAN_SYSTEMD_UNIT'] === `${serviceName}.service`) return true;
            if (c.Labels?.['app'] === serviceName) return true;
            if (c.Names?.some((n: string) => n.includes(serviceName))) return true;
            return false;
        });
        return found;
    };

    // Collect PIDs for internal mapping
    services.forEach(service => {
        if (service.active) {
             const container = getContainerForService(service.name);
             if (container) {
                 const inspect = inspectMap.get(container.Id);
                 if (inspect && inspect.State?.Pid) {
                     containerToPid.set(container.Id, inspect.State.Pid);
                 }
             }
        }
    });

    // Populate hostPortsMap directly from enriched containers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hostPortsMap = new Map<number, any[]>();
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containers.forEach((c: any) => {
        if (c.State !== 'running') return;
        
        const inspect = inspectMap.get(c.Id);
        // Map PID to Ports if available (enriched via getEnrichedContainers)
        if (inspect?.State?.Pid && c.Ports && c.Ports.length > 0) {
             hostPortsMap.set(inspect.State.Pid, c.Ports);
             
             // Ensure standalone containers are also in containerToPid if needed
             if (!containerToPid.has(c.Id)) {
                 containerToPid.set(c.Id, inspect.State.Pid);
             }
        }
    });
    
    // Find the Reverse Proxy Service
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Analyzing services...`, node: nodeName });
    
    const proxyService = services.find(s => s.isReverseProxy);
    const proxyServiceName = proxyService?.name || 'nginx-web';

    logger.info('NetworkService', `Scanning ${nodeName} for proxy service: "${proxyServiceName}". Found ${containers.length} containers.`);

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

    // V4.1: Prioritize Agent Data for Nginx Config
    // twinNode is already defined above
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentProxyRoutes = (twinNode as any)?.proxy;

    if (agentProxyRoutes && agentProxyRoutes.length > 0) {
        logger.info('NetworkService', `Using Agent-provided Nginx routes for ${nodeName} (${agentProxyRoutes.length} routes)`);
        
        // Construct Nginx Config from Agent Data
        nginxConfig = {
            servers: agentProxyRoutes.map((r: any) => ({
                server_name: [r.host], // Standard Nginx Parser output structure
                listen: r.ssl ? ['443 ssl', '80'] : ['80'],
                locations: [{
                    path: '/',
                    proxy_pass: typeof r.targetService === 'string' && r.targetService.startsWith('http') ? r.targetService : `http://${r.targetService}`
                }],
                // Metadata
                _agent_data: true,
                _ssl: r.ssl,
                _targetPort: r.targetPort || 80
            }))
        };
        
        // Verify Domains
        try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
            if (verifiedDomains.length > 0) {
                logger.info('NetworkService', `Verified domains for ${nodeName} (Agent): ${verifiedDomains.join(', ')}`);
            }
        } catch (e) {
            console.warn(`[NetworkService] Failed to check domains via Agent data`, e);
        }
    } else if (nginxContainer) {
        logger.warn('NetworkService', `Nginx container found on ${nodeName} but no Agent proxy data available. Skipping legacy SSH introspection.`);
    }

    // 1. Nginx Node (Per Server)
    const nginxId = prefix('group-nginx'); // Combined Group & Node
    // const nginxGroupId = prefix('group-nginx'); // Removed
    
    // Only add Nginx node if we found the container or it's expected
    if (nginxContainer || proxyService) {
        // Create Nginx Proxy Node (Group)
        nodes.push({
            id: nginxId,
            type: 'proxy',
            label: proxyServiceName,
            subLabel: nodeName === 'local' ? `Reverse Proxy (${nodeIPs[0] || 'localhost'})` : `Proxy (${nodeName} - ${nodeIPs[0] || '?'})`,
            ports: [80, 443],
            status: 'up',
            node: nodeName,
            metadata: {
                source: 'Nginx Config',
                link: null,
                verifiedDomains,
                nodeHost,
                nodeIPs
            },
            rawData: {
                ...nginxConfig,
                type: 'gateway',
                name: proxyServiceName
            }
        });
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
                
                // Determine Ports: YAML vs Host Scan
                let finalPorts: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
                
                if (service.hostNetwork && service.active) {
                     // Try to get dynamic ports
                     const container = getContainerForService(service.name);
                     if (container) {
                         const pid = containerToPid.get(container.Id);
                         if (pid && hostPortsMap.has(pid)) {
                             const realPorts = hostPortsMap.get(pid)!;
                             console.log(`[NetworkService] Using dynamic host ports for Proxy ${service.name}:`, realPorts.map(p => p.host_port).join(', '));
                             finalPorts = realPorts.map(p => {
                                 // Return just host port for host networking usually, or mapped object
                                 // NetworkNode expects number or {host, container}
                                 // For host network, hostPort == containerPort usually
                                 return { host: p.host_port, container: p.container_port, host_ip: p.host_ip }; 
                             });
                         }
                     }
                }

                // Fallback to YAML/Config ports if dynamic scan found nothing (or not host network)
                if (finalPorts.length === 0) {
                     finalPorts = (service.ports || []).map((p: any) => {
                        const hostPort = p.host ? (p.host.includes(':') ? parseInt(p.host.split(':')[1]) : parseInt(p.host)) : 0;
                        const containerPort = p.container ? parseInt(p.container) : 0;
                        if (hostPort > 0 && containerPort > 0) {
                            return { host: hostPort, container: containerPort };
                        }
                        return hostPort;
                    }).filter((p: any) => p !== 0 && (typeof p === 'number' ? !isNaN(p) : true));
                }

                if (finalPorts.length > 0) {
                    nginxNode.ports = finalPorts;
                }
                continue;
            }
        }

        const serviceGroupId = prefix(`group-service-${service.name}`);

        // Prepare ports for service node
        let servicePorts: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

        if (service.hostNetwork && service.active) {
                const container = getContainerForService(service.name);
                if (container) {
                    const pid = containerToPid.get(container.Id);
                    if (pid && hostPortsMap.has(pid)) {
                        const realPorts = hostPortsMap.get(pid)!;
                        console.log(`[NetworkService] Using dynamic host ports for ${service.name}:`, realPorts.map(p => p.host_port).join(', '));
                        servicePorts = realPorts.map(p => ({ host: p.host_port, container: p.container_port, host_ip: p.host_ip }));
                    }
                }
        }

        if (servicePorts.length === 0) {
             servicePorts = (service.ports || []).map((p: any) => {
                const hostPort = p.host ? (p.host.includes(':') ? parseInt(p.host.split(':')[1]) : parseInt(p.host)) : 0;
                const containerPort = p.container ? parseInt(p.container) : 0;
                if (hostPort > 0 && containerPort > 0) {
                    return { host: hostPort, container: containerPort };
                }
                return hostPort;
            }).filter((p: any) => p !== 0 && (typeof p === 'number' ? !isNaN(p) : true));
        }

        // Create Service Node (Merged Group & Node)
        nodes.push({
            id: serviceGroupId,
            type: 'service', // Managed Service is a Service Node (acting as Group)
            label: service.name,
            subLabel: nodeName === 'local' ? `Managed Service (${nodeIPs[0] || 'localhost'})` : `Service (${nodeName} - ${nodeIPs[0] || '?'})`,
            ports: servicePorts,
            status: service.active ? 'up' : 'down',
            node: nodeName,
            metadata: {
                source: 'Systemd/Podman',
                description: service.description,
                link: null,
                nodeHost,
                nodeIPs
            },
            rawData: {
                ...service,
                type: 'service'
            }
        });
    }

    // 3. Router -> Nginx Edges (Port Forwarding & Verified Domains)
    // If we have port forwardings to a remote node IP, we should link them too.
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relevantMappings = fbStatus?.portMappings?.filter((m: any) => 
        m.enabled && nodeIPs.includes(m.internalClient)
    ) || [];

    const hasMappings = relevantMappings.length > 0;
    const hasDomains = verifiedDomains.length > 0;

    if ((hasMappings || hasDomains) && nodes.find(n => n.id === nginxId)) {
        let label = '';
        if (hasMappings) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label = ':' + relevantMappings.map((m: any) => m.externalPort).join(', ');
        } else {
            label = ':80, :443';
        }

        edges.push({
            id: `edge-router-${nginxId}`,
            source: routerId,
            target: nginxId,
            label: label,
            protocol: hasDomains ? 'http' : 'tcp',
            port: hasMappings ? relevantMappings[0].externalPort : (hasDomains ? 80 : 0),
            state: 'active'
        });
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
                        if (!targetId && targetHost) {
                            // Special handling for localhost/127.0.0.1: Treat as self-reference (User Request)
                            if (['localhost', '127.0.0.1', '::1'].includes(targetHost)) {
                                targetId = nginxId;
                            } else {
                                const isLocal = nodeIPs.includes(targetHost);
                                const type = isLocal ? 'missing' : 'external';
                                
                                targetId = prefix(`${type}-${targetHost}-${targetPort}`);
                                
                                if (!nodes.find(n => n.id === targetId)) {
                                    nodes.push({
                                        id: targetId,
                                        type: 'device',
                                        label: targetHost,
                                        subLabel: isLocal ? `Unresolved (${targetPort})` : `External (${targetPort})`,
                                        ports: [targetPort],
                                        status: isLocal ? 'down' : 'up',
                                        node: nodeName,
                                        metadata: {
                                            source: 'Nginx Proxy',
                                            description: isLocal 
                                                ? `Nginx proxies to ${targetHost}:${targetPort}, but no container was found listening on this port.`
                                                : `External Service detected via Nginx configuration.`,
                                            link: `http://${targetHost}:${targetPort}`,
                                            nodeHost,
                                            verifiedDomains: [],
                                            expectedTarget: `Host: ${targetHost}, Port: ${targetPort} (${isLocal ? 'Local' : 'External'})`
                                        },
                                        rawData: {
                                            type: 'device',
                                            name: targetHost,
                                            ip: targetHost,
                                            isVirtual: true
                                        }
                                    });
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
        if (container.Image === 'localhost/podman-pause:4.3.1-0' || container.Names?.some((n: string) => n.includes('-infra'))) continue;

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
                 } else if (services.some(s => getContainerForService(s.name)?.Id === container.Id)) {
                     // If it's part of a service we already processed, we might have missed it if not directly in hostPortsMap?
                     // No, if it was in services and hostNetwork=true, it should be in hostPortsMap.
                     // But standalone containers were NOT in hostPids initially! We need to fix that earlier.
                 }
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

            nodes.push({
                id: containerId,
                type: 'container',
                label: containerName || container.Id.substring(0, 12),
                subLabel: ip,
                hostname: hostname,
                ip: ip,
                ports: ports,
                status: container.State === 'running' ? 'up' : 'down',
                parentNode: isProxy ? nginxId : undefined,
                extent: isProxy ? 'parent' : undefined,
                node: nodeName,
                metadata: {
                    source: 'Podman (Orphan)',
                    link: hostPort ? `http://${nodeHost}:${hostPort}` : null,
                    containerId: container.Id,
                    nodeHost,
                    nodeIPs,
                    verifiedDomains: linkedUrls
                },
                rawData: {
                    ...container,
                    type: 'container',
                    name: containerName,
                    hostNetwork: isHostNetwork
                }
            });
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
            serviceGroupId = isProxyService ? nginxId : prefix(`group-service-${parentService.name}`);
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
                    ports: [],
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
