import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { FritzBoxClient } from '../fritzbox/client';
import { NginxParser } from '../nginx/parser';
import { getPodmanPs, listServices } from '../manager';
import { getConfig } from '../config';
import { NetworkStore } from './store';
import { checkDomains } from './dns';
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
    const nginxParser = new NginxParser();
    const nginxConfig = await nginxParser.parse();

    // Check Domains
    const domainStatuses = await checkDomains(nginxConfig, fbStatus);
    const verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);

    // 1. Internet Node
    nodes.push({
      id: 'internet',
      type: 'internet',
      label: 'Internet',
      ports: [],
      status: 'up',
      metadata: {
          verifiedDomains
      }
    });

    // 2. Router Node (FritzBox)
    const routerId = 'router';
    nodes.push({
      id: routerId,
      type: 'router',
      label: 'Fritz!Box',
      subLabel: fbStatus?.externalIP || 'Unknown IP',
      ports: [80, 443],
      status: fbStatus?.connected ? 'up' : 'down',
      metadata: { 
        uptime: fbStatus?.uptime,
        source: 'FritzBox TR-064',
        link: 'http://fritz.box',
        internalIP: fbStatus?.internalIP
      },
      rawData: fbStatus
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
      type: 'proxy',
      label: 'Nginx',
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
                const servicePorts = service.ports.map(p => parseInt(p.host?.split(':')[1] || '0')).filter(p => p > 0);
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
            ports: service.ports.map(p => parseInt(p.host?.split(':')[1] || '0')).filter(p => p > 0),
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

        nodes.push({
            id: linkId,
            type: 'service',
            label: link.name,
            subLabel: hostname,
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

    // 5. Get Containers
    const containers = await getPodmanPs();

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
                    label: `${mapping.externalPort} -> ${mapping.internalPort}`,
                    protocol: mapping.protocol.toLowerCase() as 'tcp' | 'udp',
                    port: mapping.externalPort,
                    state: 'active'
                });
            } else {
                // Traffic to OTHER devices on the network
                const deviceId = `device-${mapping.internalClient.replace(/\./g, '-')}`;
                
                if (!nodes.find(n => n.id === deviceId)) {
                    nodes.push({
                        id: deviceId,
                        type: 'service', // Generic service/device
                        label: mapping.description || mapping.internalClient,
                        subLabel: mapping.internalClient,
                        ports: [],
                        status: 'unknown',
                        metadata: {
                            source: 'FritzBox Port Forwarding',
                            link: `http://${mapping.internalClient}` // Guess
                        }
                    });
                }

                // Add port to device ports list
                const deviceNode = nodes.find(n => n.id === deviceId);
                if (deviceNode && !deviceNode.ports.includes(mapping.internalPort)) {
                    deviceNode.ports.push(mapping.internalPort);
                }

                edges.push({
                    id: `edge-router-${deviceId}-${mapping.externalPort}`,
                    source: routerId,
                    target: deviceId,
                    label: `${mapping.externalPort} -> ${mapping.internalPort}`,
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
                        return c.Ports.some((p: any) => p.HostPort === targetPort);
                    });

                    if (targetContainer) {
                        const containerId = `container-${targetContainer.Id.substring(0, 12)}`;
                        
                        // Add container node if not exists
                        if (!nodes.find(n => n.id === containerId)) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const ports = targetContainer.Ports?.map((p: any) => p.ContainerPort) || [];
                            nodes.push({
                                id: containerId,
                                type: 'container',
                                label: targetContainer.Names[0] || targetContainer.Id.substring(0, 12),
                                subLabel: targetContainer.Image,
                                ports: ports,
                                status: targetContainer.State === 'running' ? 'up' : 'down',
                                metadata: {
                                    source: 'Podman',
                                    link: targetPort ? `http://localhost:${targetPort}` : null,
                                    containerId: targetContainer.Id
                                },
                                rawData: {
                                    ...targetContainer,
                                    type: 'container'
                                }
                            });
                        }

                        // Add Edge Nginx -> Container
                        const serverNames = server.server_name.join(', ');
                        edges.push({
                            id: `edge-nginx-${containerId}-${targetPort}`,
                            source: nginxId,
                            target: containerId,
                            label: `${serverNames}${loc.path} -> :${targetPort}`,
                            protocol: 'http',
                            port: targetPort,
                            state: 'active'
                        });
                    }
                }
            }
        }
    }

    // Add remaining containers that are not linked (orphans)
     
    for (const container of containers) {
        // Skip system containers (e.g. podman-pause)
        if (container.Image === 'localhost/podman-pause:4.3.1-0' || container.Names?.some((n: string) => n.includes('-infra'))) {
            continue;
        }

        // Check if this container is the Reverse Proxy
        // We check for the specific label, or if it matches the known nginx service name
         
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
                // Don't add as separate node
                continue;
            }
        }

        const containerId = `container-${container.Id.substring(0, 12)}`;
        if (!nodes.find(n => n.id === containerId)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ports = container.Ports?.map((p: any) => p.ContainerPort) || [];
            // Try to find a host port for link
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hostPort = container.Ports?.find((p: any) => p.HostPort)?.HostPort;

            nodes.push({
                id: containerId,
                type: 'container',
                label: container.Names[0] || container.Id.substring(0, 12),
                subLabel: container.Image,
                ports: ports,
                status: container.State === 'running' ? 'up' : 'down',
                metadata: {
                    source: 'Podman (Orphan)',
                    link: hostPort ? `http://localhost:${hostPort}` : null,
                    containerId: container.Id
                },
                rawData: {
                    ...container,
                    type: 'container'
                }
            });
        }
    }

    // 6.5 Link Services to Containers
    for (const node of nodes) {
        if (node.type === 'container' && node.rawData) {
            const container = node.rawData;
            // Try to find parent service
            // 1. By Pod Name Label
            const podName = container.Labels?.['io.podman.pod.name'] || container.Labels?.['io.kubernetes.pod.name'];
            // 2. By Name convention (Service Name is prefix of Container Name)
            const containerName = container.Names[0].replace(/^\//, ''); // Remove leading slash
            
            const parentService = services.find(s => {
                if (podName && (s.name === podName || podName.includes(s.name))) return true;
                // Strict prefix match: service "app", container "app-web"
                if (containerName.startsWith(s.name + '-')) return true;
                if (containerName === s.name) return true;
                return false;
            });

            if (parentService) {
                const serviceId = `service-${parentService.name}`;
                // Avoid duplicates
                if (!edges.find(e => e.source === serviceId && e.target === node.id)) {
                    edges.push({
                        id: `edge-service-${parentService.name}-${node.id}`,
                        source: serviceId,
                        target: node.id,
                        label: undefined, // No label for hierarchy
                        protocol: 'tcp',
                        port: 0,
                        state: 'active',
                        isManual: false
                    });
                }
            }
        }
    }

    // 7. Add Manual Edges
    const manualEdges = await NetworkStore.getEdges();
    for (const edge of manualEdges) {
        edges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            label: edge.label || 'Manual',
            protocol: 'tcp',
            port: 0,
            state: 'active',
            isManual: true
        });
    }

    return { nodes, edges };
  }
}
