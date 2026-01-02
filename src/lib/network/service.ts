import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { FritzBoxClient } from '../fritzbox/client';
import { NginxParser } from '../nginx/parser';
import { getPodmanPs, listServices, getAllContainersInspect } from '../manager';
import { getConfig } from '../config';
import { NetworkStore } from './store';
import { checkDomains, resolveHostname } from './dns';
import os from 'os';

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

  async getGraph(): Promise<NetworkGraph> {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];

    // 0. Prepare Data
    const config = await getConfig();
    const containers = await getPodmanPs();
    const containerInspections = await getAllContainersInspect();
    
    // FritzBox Status
    let fbClient: FritzBoxClient;
    if (config.gateway?.enabled && config.gateway.type === 'fritzbox') {
        fbClient = new FritzBoxClient({
            host: config.gateway.host,
            username: config.gateway.username,
            password: config.gateway.password
        });
    } else {
        fbClient = new FritzBoxClient();
    }

    let fbStatus = null;
    try {
      fbStatus = await fbClient.getStatus();
    } catch (e) {
      console.warn('Failed to get FritzBox status', e);
    }

    // Nginx Config
    // Find Nginx Container
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nginxContainer = containers.find((c: any) => 
        (c.Labels && c.Labels['podcli.role'] === 'reverse-proxy') ||
        (c.Names && c.Names.some((n: string) => n.includes('/nginx-web') || n.includes('/nginx')))
    );

    let nginxParser: NginxParser;
    if (process.env.MOCK_NGINX_PATH) {
        console.log('Using mock Nginx config from:', process.env.MOCK_NGINX_PATH);
        nginxParser = new NginxParser(process.env.MOCK_NGINX_PATH);
    } else {
        nginxParser = new NginxParser('/etc/nginx', nginxContainer?.Id);
    }
    const nginxConfig = await nginxParser.parse();
    console.log('[NetworkService] Nginx Config Servers:', JSON.stringify(nginxConfig.servers, null, 2));

    // Check Domains
    const domainStatuses = await checkDomains(nginxConfig, fbStatus);
    let verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);

    if (process.env.MOCK_NGINX_PATH) {
        // In mock mode, treat all found domains as verified so they appear in the graph
        verifiedDomains = domainStatuses.map(d => d.domain);
        console.log('[NetworkService] Mock Mode - Verified Domains:', verifiedDomains);
    }

    // 1. Internet Node
    nodes.push({
      id: 'internet',
      type: 'internet',
      label: 'Internet',
      ports: [],
      status: 'up',
      metadata: {
          // verifiedDomains moved to Router
      }
    });

    // 2. Router Node (FritzBox)
    const routerId = 'router';
    const routerHost = config.gateway?.host || 'fritz.box';
    const resolvedRouterHost = await resolveHostname(routerHost);
    
    const isRouterResolved = resolvedRouterHost && resolvedRouterHost !== routerHost;
    const routerSubLabel = isRouterResolved ? routerHost : (resolvedRouterHost || routerHost);
    const routerHostnameField = isRouterResolved ? resolvedRouterHost : undefined;

    nodes.push({
      id: routerId,
      type: 'router',
      label: 'Fritz!Box',
      subLabel: routerSubLabel, 
      hostname: routerHostnameField,
      ports: [80, 443],
      status: fbStatus?.connected ? 'up' : 'down',
      metadata: { 
        uptime: fbStatus?.uptime,
        source: 'FritzBox TR-064',
        link: 'http://fritz.box',
        internalIP: fbStatus?.internalIP,
        verifiedDomains
      },
      rawData: {
          ...fbStatus,
          type: 'router'
      }
    });

    edges.push({
        id: 'edge-internet-router',
        source: 'internet',
        target: routerId,
        protocol: 'tcp',
        port: 0,
        state: fbStatus?.connected ? 'active' : 'inactive'
    });

    // 4. Nginx Node

    // 4. Nginx Node
    // We assume Nginx is running on the host
    const nginxId = 'nginx';
    nodes.push({
      id: nginxId,
      type: 'proxy', // Changed to proxy to act as a container
      label: 'Nginx',
      subLabel: 'Reverse Proxy',
      ports: [80, 443], // We will refine this from config
      status: 'up', // We should check systemd status really
      metadata: {
        source: 'Nginx Config',
        link: null
      },
      rawData: {
          ...nginxConfig,
          type: 'gateway',
          name: 'nginx-web' // Assuming this is the service name for editing
      }
    });

    // 4.5 Add Managed Services & External Links
    const services = await listServices();
    const externalLinks = config.externalLinks || [];

    for (const service of services) {
        // Merge Nginx service with the existing Nginx node
        // Check by name OR by label
        const isProxy = service.name.toLowerCase() === 'nginx' || 
                        service.name.toLowerCase() === 'nginx-web' ||
                        (service.labels && service.labels['podcli.role'] === 'reverse-proxy');

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                nginxNode.status = service.active ? 'up' : 'down';
                nginxNode.subLabel = 'Managed Proxy';
                if (nginxNode.metadata) {
                    nginxNode.metadata.serviceDescription = service.description;
                }
                // Update ports from service definition if available
                const servicePorts = service.ports.map(p => {
                    const hostPort = p.host ? (p.host.includes(':') ? parseInt(p.host.split(':')[1]) : parseInt(p.host)) : 0;
                    const containerPort = p.container ? parseInt(p.container) : 0;
                    if (hostPort > 0 && containerPort > 0) {
                        return { host: hostPort, container: containerPort };
                    }
                    return hostPort;
                }).filter(p => p !== 0 && (typeof p === 'number' ? !isNaN(p) : true));
                
                if (servicePorts.length > 0) {
                    nginxNode.ports = servicePorts;
                }
                continue;
            }
        }

        const serviceId = `service-${service.name}`;
        nodes.push({
            id: serviceId,
            type: 'service',
            label: service.name,
            subLabel: 'Managed Service',
            ports: service.ports.map(p => {
                const hostPort = p.host ? (p.host.includes(':') ? parseInt(p.host.split(':')[1]) : parseInt(p.host)) : 0;
                const containerPort = p.container ? parseInt(p.container) : 0;
                if (hostPort > 0 && containerPort > 0) {
                    return { host: hostPort, container: containerPort };
                }
                return hostPort;
            }).filter(p => p !== 0 && (typeof p === 'number' ? !isNaN(p) : true)),
            status: service.active ? 'up' : 'down',
            metadata: {
                source: 'Systemd/Podman',
                description: service.description,
                link: null
            },
            rawData: {
                ...service,
                type: 'service'
            }
        });
    }

    for (const link of externalLinks) {
        const linkId = `link-${link.id}`;
        let hostname = 'External Link';
        try {
            hostname = new URL(link.url).hostname;
        } catch {
            // ignore invalid urls
        }

        const resolvedHostname = await resolveHostname(hostname);
        
        // If we have both an IP (hostname) and a resolved name, show IP in subLabel and Name in hostname field (with icon)
        const isResolved = resolvedHostname && resolvedHostname !== hostname;
        const subLabel = isResolved ? hostname : (resolvedHostname || hostname);
        const hostnameField = isResolved ? resolvedHostname : undefined;

        nodes.push({
            id: linkId,
            type: 'link',
            label: link.name,
            subLabel: subLabel,
            hostname: hostnameField,
            ports: [],
            status: 'up',
            metadata: {
                source: 'External Link',
                link: link.url,
                description: link.description
            },
            rawData: {
                ...link,
                type: 'link'
            }
        });
    }

    // 5. Get Containers (Already fetched at step 0)
    // const containers = await getPodmanPs();

    // 6. Build Graph Logic
    const localIPs = this.getLocalIPs();
    
    // Router -> Nginx (Port Forwardings)
    if (fbStatus?.portMappings) {
      for (const mapping of fbStatus.portMappings) {
        if (mapping.enabled) {
            const isLocal = localIPs.includes(mapping.internalClient);
            
            if (isLocal) {
                // Traffic to THIS server (Nginx/Podman)
                // We assume it hits Nginx if it's web traffic, or maybe direct to container?
                // For now, link to Nginx node as the entry point
                edges.push({
                    id: `edge-router-nginx-${mapping.externalPort}`,
                    source: routerId,
                    target: nginxId,
                    label: `:${mapping.internalPort}`,
                    protocol: mapping.protocol.toLowerCase() as 'tcp' | 'udp',
                    port: mapping.externalPort,
                    state: 'active'
                });
            } else {
                // Traffic to OTHER devices on the network
                const deviceId = `device-${mapping.internalClient.replace(/\./g, '-')}`;
                
                if (!nodes.find(n => n.id === deviceId)) {
                    const resolvedHostname = await resolveHostname(mapping.internalClient);

                    nodes.push({
                        id: deviceId,
                        type: 'device', // Generic service/device
                        label: resolvedHostname || mapping.description || mapping.internalClient,
                        subLabel: mapping.internalClient,
                        hostname: resolvedHostname || mapping.internalClient, // Usually an IP, but could be hostname
                        ports: [],
                        status: 'unknown',
                        metadata: {
                            source: 'FritzBox Port Forwarding',
                            link: `http://${mapping.internalClient}` // Guess
                        },
                        rawData: {
                            type: 'device',
                            ip: mapping.internalClient,
                            description: mapping.description || 'Auto-detected device via Port Forwarding'
                        }
                    });
                }

                edges.push({
                    id: `edge-router-${deviceId}-${mapping.externalPort}`,
                    source: routerId,
                    target: deviceId,
                    label: `:${mapping.internalPort}`,
                    protocol: mapping.protocol.toLowerCase() as 'tcp' | 'udp',
                    port: mapping.externalPort,
                    state: 'active'
                });
            }
        }
      }
    }

    // Nginx -> Containers
    // Iterate Server Blocks
    for (const server of nginxConfig.servers) {
        // Create a node for the Virtual Host? 
        // Or just edges from Nginx to Containers?
        // User wants "Fritzbox -> Nginx -> Service/Container"
        // So Nginx is the central node.
        
        // Let's look at locations
        for (const loc of server.locations) {
            if (loc.proxy_pass) {
                // Extract target port from proxy_pass (e.g. http://localhost:3000)
                const match = loc.proxy_pass.match(/:(\d+)/);
                if (match) {
                    const targetPort = parseInt(match[1], 10);
                    
                    // Find container listening on this port
                    // Podman JSON: "Ports": [{"HostPort": 3000, "ContainerPort": 3000}]
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const targetContainer = containers.find((c: any) => {
                        if (!c.Ports) return false;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        return c.Ports.some((p: any) => {
                            const hostPort = p.HostPort || p.host_port;
                            return hostPort === targetPort;
                        });
                    });

                    if (targetContainer) {
                        const containerId = `container-${targetContainer.Id.substring(0, 12)}`;
                        const containerName = targetContainer.Names[0].replace(/^\//, '');
                        
                        // Add container node if not exists
                        let node = nodes.find(n => n.id === containerId);
                        if (!node) {
                            // Extract IP from Networks
                            let ip = null;
                            if (targetContainer.Networks) {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const networks = Object.values(targetContainer.Networks) as any[];
                                if (networks.length > 0 && networks[0].IPAddress) {
                                    ip = networks[0].IPAddress;
                                }
                            }

                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const ports = targetContainer.Ports?.map((p: any) => {
                                const containerPort = parseInt(p.ContainerPort || p.container_port || '0');
                                const hostPort = parseInt(p.HostPort || p.host_port || '0');
                                if (hostPort > 0 && containerPort > 0) {
                                    return { host: hostPort, container: containerPort };
                                }
                                return containerPort || hostPort || 0;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            }).filter((p: any) => p !== 0) || [];
                            
                            node = {
                                id: containerId,
                                type: 'container',
                                label: containerName || targetContainer.Id.substring(0, 12),
                                subLabel: ip, // Only show IP if available
                                ip: ip,
                                ports: ports,
                                status: targetContainer.State === 'running' ? 'up' : 'down',
                                metadata: {
                                    source: 'Podman',
                                    link: targetPort ? `http://localhost:${targetPort}` : null,
                                    containerId: targetContainer.Id,
                                    verifiedDomains: []
                                },
                                rawData: {
                                    ...targetContainer,
                                    type: 'container',
                                    name: containerName
                                }
                            };
                            nodes.push(node);
                        }

                        // Update verifiedDomains
                        if (!node.metadata) node.metadata = {};
                        if (!node.metadata.verifiedDomains) node.metadata.verifiedDomains = [];
                        for (const domain of server.server_name) {
                            if (!node.metadata.verifiedDomains.includes(domain)) {
                                node.metadata.verifiedDomains.push(domain);
                            }
                        }

                        // Add Edge Nginx -> Container
                        edges.push({
                            id: `edge-nginx-${containerId}-${targetPort}`,
                            source: nginxId,
                            target: containerId,
                            label: `:${targetPort}`,
                            protocol: 'http',
                            port: targetPort,
                            state: 'active'
                        });
                    } else if (process.env.MOCK_NGINX_PATH) {
                        console.log(`[NetworkService] Mock Mode - Creating phantom node for ${loc.proxy_pass}`);
                        // Create a phantom node for the upstream service in mock mode
                        const upstreamHost = loc.proxy_pass.replace(/^https?:\/\//, '').split(':')[0];
                        const containerId = `mock-${upstreamHost}`;
                        
                        let node = nodes.find(n => n.id === containerId);
                        if (!node) {
                            node = {
                                id: containerId,
                                type: 'container',
                                label: upstreamHost,
                                subLabel: 'Mock Container',
                                ports: [{ host: targetPort, container: targetPort }],
                                status: 'down',
                                metadata: {
                                    source: 'Nginx Upstream (Mock)',
                                    link: null,
                                    verifiedDomains: []
                                },
                                rawData: {
                                    type: 'container',
                                    name: upstreamHost,
                                    Id: containerId,
                                    Names: [`/${upstreamHost}`]
                                }
                            };
                            nodes.push(node);
                        }

                        // Update verifiedDomains
                        if (!node.metadata) node.metadata = {};
                        if (!node.metadata.verifiedDomains) node.metadata.verifiedDomains = [];
                        for (const domain of server.server_name) {
                            if (!node.metadata.verifiedDomains.includes(domain)) {
                                node.metadata.verifiedDomains.push(domain);
                            }
                        }

                        edges.push({
                            id: `edge-nginx-${containerId}-${targetPort}`,
                            source: nginxId,
                            target: containerId,
                            label: `:${targetPort}`,
                            protocol: 'http',
                            port: targetPort,
                            state: 'inactive'
                        });
                    }
                }
            }
        }
    }

    // Add remaining containers that are not linked (orphans)
     
    for (const container of containers) {
        if (!container || (!container.Id && (!container.Names || container.Names.length === 0))) {
            console.warn('[NetworkService] Skipping invalid container:', container);
            continue;
        }

        // Skip system containers (e.g. podman-pause)
        if (container.Image === 'localhost/podman-pause:4.3.1-0' || container.Names?.some((n: string) => n.includes('-infra'))) {
            continue;
        }

        const containerId = container.Id;

        // Check if this container is the Reverse Proxy
        // We check for the specific label, or if it matches the known nginx service name, OR if it's configured in settings
         
        const isProxy = (container.Labels && container.Labels['podcli.role'] === 'reverse-proxy') ||
                        (container.Names && container.Names.some((n: string) => n.includes('/nginx-web') || n.includes('/nginx')));

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                // Update status from container
                nginxNode.status = container.State === 'running' ? 'up' : 'down';
                
                if (nginxNode.metadata) {
                    nginxNode.metadata.containerId = container.Id;
                    nginxNode.metadata.image = container.Image;
                }
            }
            // Do NOT continue, we want to add the container node inside the Nginx group
        }

        const containerName = container.Names[0].replace(/^\//, '');

        if (!nodes.find(n => n.id === containerId)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ports = container.Ports?.map((p: any) => {
                const containerPort = parseInt(p.ContainerPort || p.container_port || '0');
                const hostPort = parseInt(p.HostPort || p.host_port || '0');
                if (hostPort > 0 && containerPort > 0) {
                    return { host: hostPort, container: containerPort };
                }
                return containerPort || hostPort || 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
                            }).filter((p: any) => p !== 0) || [];
            // Try to find a host port for link
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hostPort = container.Ports?.find((p: any) => (p.HostPort || p.host_port))?.HostPort || container.Ports?.find((p: any) => (p.HostPort || p.host_port))?.host_port;

            // Extract IP from Networks
            let ip = null;
            if (container.Networks) {
                // Podman JSON format for Networks can vary, usually it's an object with network names as keys
                // e.g. "Networks": { "podman": { "IPAddress": "10.88.0.2" } }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const networks = Object.values(container.Networks) as any[];
                if (networks.length > 0 && networks[0].IPAddress) {
                    ip = networks[0].IPAddress;
                }
            }

            // Extract Hostname from Inspection Data
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inspection = containerInspections.find((i: any) => i.Id.startsWith(containerId) || containerId.startsWith(i.Id));
            const hostname = inspection?.Config?.Hostname || containerId.substring(0, 12);

            nodes.push({
                id: containerId,
                type: 'container',
                label: containerName || container.Id.substring(0, 12),
                subLabel: ip, // Only show IP if available, user requested to remove Image name
                hostname: hostname,
                ip: ip,
                ports: ports,
                status: container.State === 'running' ? 'up' : 'down',
                parentNode: isProxy ? nginxId : undefined,
                extent: isProxy ? 'parent' : undefined,
                metadata: {
                    source: 'Podman (Orphan)',
                    link: hostPort ? `http://localhost:${hostPort}` : null,
                    containerId: container.Id
                },
                rawData: {
                    ...container,
                    type: 'container',
                    name: containerName
                }
            });
        }
    }

    // 6.5 Link Services to Containers
    for (const node of nodes) {
        if (node.type === 'container' && node.rawData) {
            const container = node.rawData;
            
            // 1. Identify Pod
            const podName = container.PodName || container.Labels?.['io.podman.pod.name'] || container.Labels?.['io.kubernetes.pod.name'];
            let podId: string | null = null;

            if (podName) {
                podId = `pod-${podName}`;
                // Create Pod Node if not exists
                if (!nodes.find(n => n.id === podId)) {
                    nodes.push({
                        id: podId,
                        type: 'pod',
                        label: podName,
                        subLabel: 'Pod',
                        ports: [],
                        status: 'up',
                        metadata: { source: 'Podman Pod' },
                        rawData: { type: 'pod', name: podName }
                    });
                }
                
                // Assign Container to Pod
                node.parentNode = podId;
                node.extent = 'parent';
                if (node.metadata) {
                    node.metadata.source = 'Podman Pod';
                }
            }

            // 2. Identify Service
            const containerName = (container.Names && container.Names.length > 0) 
                ? container.Names[0].replace(/^\//, '') 
                : (container.Id ? container.Id.substring(0, 12) : (container.name || 'unknown'));
            
            const parentService = services.find(s => {
                if (podName && (s.name === podName || podName.includes(s.name))) return true;
                // Strict prefix match: service "app", container "app-web"
                if (containerName.startsWith(s.name + '-')) return true;
                if (containerName === s.name) return true;
                return false;
            });

            if (parentService) {
                const isProxyService = parentService.name === 'nginx' || parentService.name === 'nginx-web' || (parentService.labels && parentService.labels['podcli.role'] === 'reverse-proxy');
                const serviceId = isProxyService ? 'nginx' : `service-${parentService.name}`;
                
                // If Container is in a Pod, the POD goes into the Service
                if (podId) {
                    const podNode = nodes.find(n => n.id === podId);
                    if (podNode) {
                        podNode.parentNode = serviceId;
                        podNode.extent = 'parent';
                        if (podNode.metadata) {
                            podNode.metadata.source = 'Managed Service';
                        }
                    }
                    // Also update container source to reflect it's part of a service
                    if (node.metadata) {
                        node.metadata.source = 'Managed Service (Pod)';
                    }
                } else {
                    // Container directly in Service
                    node.parentNode = serviceId;
                    node.extent = 'parent';
                    if (node.metadata) {
                        node.metadata.source = 'Managed Service';
                    }
                }
            }
        }
    }

    // 7. Add Manual Edges
    const manualEdges = await NetworkStore.getEdges();
    for (const edge of manualEdges) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const port = (edge as any).port;
        const label = port ? `:${port} (manual)` : 'Manual Link';
        
        edges.push({
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

    return { nodes, edges };
  }
}
