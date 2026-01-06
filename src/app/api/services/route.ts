import { NextResponse } from 'next/server';
import { listServices, saveService, getPodmanPs } from '@/lib/manager';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import { NginxParser } from '@/lib/nginx/parser';
import { checkDomains } from '@/lib/network/dns';
import { listNodes } from '@/lib/nodes';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const isLocal = !nodeName || nodeName === 'Local';
  
  // Start fetching config immediately
  const configPromise = getConfig();

  // Start fetching services immediately (resolving connection first if needed)
  const servicesPromise = (async () => {
    let connection;
    if (nodeName && nodeName !== 'Local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
    }
    return listServices(connection);
  })();

  // Wait for config to determine if we need gateway info
  const config = await configPromise;
  
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

  // Fetch Gateway Info & Domains (in parallel with services)
  const gatewayPromise = (async () => {
      if (!isLocal) return [];

      let gatewayDescription = `Fritz!Box at ${config.gateway?.host || 'unknown'}`;
      let verifiedDomains: string[] = [];

      if (config.gateway?.type === 'fritzbox') {
          try {
              const fbClient = new FritzBoxClient({
                  host: config.gateway.host,
                  username: config.gateway.username,
                  password: config.gateway.password
              });

              // Run FritzBox status and Nginx parsing in parallel
              const [status, nginxConfig] = await Promise.all([
                  fbClient.getStatus(),
                  (async () => {
                      try {
                          // Find Nginx container
                          const containers = await getPodmanPs();
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const nginxContainer = containers.find((c: any) => 
                              c.Names && c.Names.some((n: string) => n.includes('nginx-web') || n.includes('nginx'))
                          );
                          
                          if (nginxContainer) {
                              const parser = new NginxParser('/etc/nginx', nginxContainer.Id);
                              return parser.parse();
                          }
                          
                          return { servers: [] };
                      } catch (e) {
                          console.warn('Failed to parse Nginx config', e);
                          return { servers: [] };
                      }
                  })()
              ]);

              if (status.externalIP) {
                  gatewayDescription = `Online: ${status.externalIP}`;
                  
                  // Check Domains
                  // For local node, we can also check against local IPs if needed, but usually gateway check implies external access
                  // However, if we want consistency with NetworkService, we should probably include local IPs too?
                  // But here we are specifically checking "Internet Gateway" status.
                  // Let's stick to external IP for now, or maybe add local IPs if we want to support split DNS here too.
                  // Given the user's request, let's be consistent.
                  const domainStatuses = await checkDomains(nginxConfig, status);
                  verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
              }
          } catch (e) {
              console.warn('Failed to fetch gateway status for services list', e);
          }
      }

      return [{
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
          verifiedDomains // Pass to frontend
      }];
  })();

  // Wait for everything to finish
  const [services, gatewayService] = await Promise.all([servicesPromise, gatewayPromise]);

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
