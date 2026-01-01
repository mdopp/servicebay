import { NetworkGraph, NetworkNode, NetworkEdge } from './types';
import { FritzBoxClient } from '../fritzbox/client';
import { NginxParser } from '../nginx/parser';
import { getPodmanPs } from '../manager';

export class NetworkService {
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
    // Use configured host or default
    // We might need to store fritzbox credentials/host in global config
    // For now, assume default or auto-discover
    const fbClient = new FritzBoxClient(); 
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
      metadata: { uptime: fbStatus?.uptime }
    });

    edges.push({
      id: 'edge-internet-router',
      source: 'internet',
      target: routerId,
      protocol: 'tcp', // generic
      port: 0,
      state: fbStatus?.connected ? 'active' : 'inactive'
    });

    // 3. Nginx Node
    // We assume Nginx is running on the host
    const nginxId = 'nginx';
    nodes.push({
      id: nginxId,
      type: 'proxy',
      label: 'Nginx',
      ports: [80, 443], // We will refine this from config
      status: 'up' // We should check systemd status really
    });

    // 4. Parse Nginx Config
    const nginxParser = new NginxParser();
    const nginxConfig = await nginxParser.parse();

    // 5. Get Containers
    const containers = await getPodmanPs();

    // 6. Build Graph Logic
    
    // Router -> Nginx (Port Forwardings)
    if (fbStatus?.portMappings) {
      for (const mapping of fbStatus.portMappings) {
        if (mapping.enabled) {
            // If mapping points to this machine (we don't know our own IP easily without more checks, 
            // but let's assume if it points to Nginx ports it's relevant)
            // For visualization, we just show what's open.
            
            // Create an edge from Router to Nginx if the port matches Nginx listen ports
            // Or just show it as an edge to "Internal Network" if we can't match IP.
            
            // For v3 MVP, let's assume all HTTP/HTTPS traffic goes to Nginx
            if (mapping.externalPort === 80 || mapping.externalPort === 443) {
                edges.push({
                    id: `edge-router-nginx-${mapping.externalPort}`,
                    source: routerId,
                    target: nginxId,
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
                            nodes.push({
                                id: containerId,
                                type: 'container',
                                label: targetContainer.Names[0] || targetContainer.Id.substring(0, 12),
                                subLabel: targetContainer.Image,
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                ports: targetContainer.Ports?.map((p: any) => p.ContainerPort) || [],
                                status: targetContainer.State === 'running' ? 'up' : 'down'
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

    // Add remaining containers that are not linked (orphans)?
    // Maybe not for this view, to keep it clean.

    return { nodes, edges };
  }
}
