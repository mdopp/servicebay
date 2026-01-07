import { NextResponse } from 'next/server';
import { listServices, saveService, getPodmanPs } from '@/lib/manager';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import { NginxParser } from '@/lib/nginx/parser';
import { checkDomains } from '@/lib/network/dns';
import { listNodes } from '@/lib/nodes';
import { getExecutor } from '@/lib/executor';
import { NetworkService } from '@/lib/network/service';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
    ]);
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const isLocal = !nodeName || nodeName === 'Local';
  
  // Start fetching config immediately
  const configPromise = getConfig();

  // If nodeName matches recent cache in NetworkService, we might utilize it?
  // But NetworkService caches strictly by buildGraph() call.
  // Instead, let's just make listServices the source of truth for basic data,
  // and try to fetch enriched data from NetworkService logic if possible, or
  // stick with our light enrichment.

  const servicesPromise = (async () => {
    let connection;
    if (nodeName && nodeName !== 'Local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
    }
    return listServices(connection);
  })();

  // Use NetworkService to build graph for this node to get enriched data
  // This reuses the EXACT logic from the map visualization.
  const graphPromise = (async () => {
      try {
          // Use a shorter timeout since we have main content via listServices
          // But NetworkService might be slow.
          return withTimeout(NetworkService.buildGraph(), 5000, null);
      } catch (e) {
          console.warn('Failed to fetch graph for services enrichment', e);
          return null;
      }
  })();

  // Wait for everything to finish
  const [services, configResolved, graphData] = await Promise.all([servicesPromise, configPromise, graphPromise]);
  
  // Use resolved config
  const config = configResolved;

  // Only fetch links and gateway if we are on the local node
  const links = isLocal ? (config.externalLinks || []) : [];

  // Get monitoring status for links
  const checks = MonitoringStore.getChecks();

  const mappedLinks = links.map(link => {
    // Find associated check if monitored
    const check = checks.find(c => c.name === `Link: ${link.name}`);
    const lastResult = check ? MonitoringStore.getLastResult(check.id) : null;
    
    return {
        name: link.name,
        active: lastResult ? lastResult.status === 'ok' : true,
        status: lastResult ? lastResult.status : 'external',
        kubePath: '',
        yamlPath: null,
        ports: [],
        volumes: [],
        type: 'link',
        url: link.url,
        description: link.description,
        id: link.id,
        monitor: link.monitor,
        ip_targets: link.ip_targets,
        labels: {}
    };
  });


  // Gateway Info from Config + Graph Data (if available)
  const gatewayService = [];
  if (isLocal) {
       let gatewayDescription = `Fritz!Box at ${config.gateway?.host || 'unknown'}`;
       let verifiedDomains: string[] = [];
       // If graph has gateway node, use its data
       if (graphData) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const gatewayNode = graphData.nodes.find((n: any) => n.id.includes('group-router'));
            if (gatewayNode && gatewayNode.metadata?.verifiedDomains) {
                verifiedDomains = gatewayNode.metadata.verifiedDomains;
                if (gatewayNode.data?.externalIP) {
                    gatewayDescription = `Online: ${gatewayNode.data.externalIP}`;
                }
            }
       }

       // If graph didn't return gateway (e.g. timeout), rely on basic config description
       
       gatewayService.push({
          name: 'Internet Gateway',
          active: true,
          status: 'gateway',
          kubePath: '',
          yamlPath: null,
          ports: [],
          volumes: [],
          type: 'gateway',
          description: gatewayDescription,
          id: 'gateway',
          labels: {},
          verifiedDomains
      });
  }

  // Enrich Managed Services using Graph Data
  if (graphData && graphData.nodes) {
    // Map of Service Name -> Graph Node
    const nodeMap = new Map();
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphData.nodes.forEach((n: any) => {
        // Match by label, name, or metadata containerId
        if (n.data?.name) nodeMap.set(n.data.name, n);
        if (n.label) nodeMap.set(n.label, n);
    });

    // Check if Nginx is present (for reverse proxy renaming later)
    // ... logic preserved below
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services.forEach((s: any) => {
        // Try strict match
        let node = nodeMap.get(s.name);
        
        // Try base name match (immich.service -> immich)
        if (!node) {
            const baseName = s.name.replace(/\.(container|kube|service|pod)$/, '');
            node = nodeMap.get(baseName);
        }

        if (node && node.metadata?.verifiedDomains) {
            s.verifiedDomains = node.metadata.verifiedDomains;
        }
        
        // Also enrich with other metadata from graph if useful (e.g. load, uptime)
    });
  }

  // Check if Nginx is present
  const nginxIndex = services.findIndex(s => s.name === 'nginx-web' || s.name === 'nginx');

  if (nginxIndex !== -1) {
      // Rename existing service
      const originalName = services[nginxIndex].name;
      services[nginxIndex] = {
          ...services[nginxIndex],
          name: 'Reverse Proxy',
          id: originalName
      };
  } else if (isLocal) {
      // Inject virtual service
      services.push({
          name: 'Reverse Proxy',
          id: 'nginx-web',
          active: false,
          status: 'not-installed',
          kubeFile: '',
          kubePath: '',
          yamlFile: null,
          yamlPath: null,
          description: 'Reverse Proxy (Not Installed)',
          ports: [],
          volumes: [],
          labels: {},
          node: 'Local'
      });
  }

  const mappedServices = services.map(s => ({ ...s, type: 'container' }));

  return NextResponse.json([...mappedLinks, ...gatewayService, ...mappedServices]);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }
  
  // Handle Link Creation
  if (body.type === 'link') {
    const { name, url, description, monitor, ip_targets } = body;
    if (!name || !url) {
        return NextResponse.json({ error: 'Name and URL required' }, { status: 400 });
    }

    const config = await getConfig();
    
    // Parse IP Targets if provided (comma string or array)
    let parsedTargets: string[] = [];
    if (Array.isArray(ip_targets)) {
        parsedTargets = ip_targets;
    } else if (typeof ip_targets === 'string') {
        parsedTargets = ip_targets.split(',').map(s => s.trim()).filter(Boolean);
    }

    const newLink: ExternalLink = {
        id: crypto.randomUUID(),
        name,
        url,
        description,
        monitor,
        ip_targets: parsedTargets
    };

    const links = config.externalLinks || [];
    links.push(newLink);
    
    await saveConfig({ ...config, externalLinks: links });

    // Create Monitor Check if requested
    if (monitor) {
        const check = {
            id: crypto.randomUUID(),
            name: `Link: ${name}`,
            type: 'http' as const,
            target: url,
            interval: 60,
            enabled: true,
            created_at: new Date().toISOString(),
            httpConfig: { expectedStatus: 200 }
        };
        MonitoringStore.saveCheck(check);
    }

    return NextResponse.json({ success: true });
  }

  // Handle Container Creation
  const { name, kubeContent, yamlContent, yamlFileName } = body;
  
  if (!name || !kubeContent || !yamlContent || !yamlFileName) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  await saveService(name, kubeContent, yamlContent, yamlFileName, connection);
  return NextResponse.json({ success: true });
}
