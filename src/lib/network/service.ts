import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { FritzBoxClient } from '../fritzbox/client';
import { NginxParser } from '../nginx/parser';
import { getPodmanPs } from '../manager';
import { getConfig } from '../config';
import { NetworkStore } from './store';
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

    // 1. Internet Node
    nodes.push({
      id: 'internet',
      type: 'internet',
      label: 'Internet',
      ports: [],
      status: 'up'
    });

    // 2. Router Node (FritzBox)
    const config = await getConfig();
    let fbClient: FritzBoxClient;

    if (config.gateway?.enabled && config.gateway.type === 'fritzbox') {
        fbClient = new FritzBoxClient({
            host: config.gateway.host,
            username: config.gateway.username,
            password: config.gateway.password
        });
    } else {
        // Fallback to default discovery/env vars
        fbClient = new FritzBoxClient();
    }

    let fbStatus = null;
    try {
      fbStatus = await fbClient.getStatus();
    } catch (e) {
      console.warn('Failed to get FritzBox status', e);
    }

    const routerId = 'router';
    nodes.push({
      id: routerId,
      type: 'router',
      label: 'Fritz!Box',
      subLabel: fbStatus?.externalIP || 'Unknown IP',
      ports: [80, 443], // Default management ports? Or WAN ports?
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
      protocol: 'tcp', // generic
      port: 0,
      state: fbStatus?.connected ? 'active' : 'inactive'
    });

    // 3. Parse Nginx Config
    const nginxParser = new NginxParser();
    const nginxConfig = await nginxParser.parse();

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
      rawData: nginxConfig
    });

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
                                rawData: targetContainer
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
                rawData: container
            });
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
            // @ts-expect-error - Adding custom property for UI
            isManual: true
        });
    }

    return { nodes, edges };
  }
}
