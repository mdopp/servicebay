import { NextResponse } from 'next/server';
import { listServices, saveService } from '@/lib/manager';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import { listNodes } from '@/lib/nodes';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const isLocal = !nodeName || nodeName === 'Local';
  
  // Start fetching config immediately
  const configPromise = getConfig();

  const servicesPromise = (async () => {
    let connection;
    if (nodeName && nodeName !== 'Local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
    }
    return listServices(connection);
  })();

  // Wait for services and config
  const [services, configResolved] = await Promise.all([servicesPromise, configPromise]);
  
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


  // Gateway Info from Config
  const gatewayService = [];
  if (isLocal) {
       const gatewayDescription = `Fritz!Box at ${config.gateway?.host || 'unknown'}`;
       const verifiedDomains: string[] = [];

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

  // Check if ServiceBay is present (Self-Management)
  const sbIndex = services.findIndex(s => s.name === 'servicebay' || s.name === 'ServiceBay');

  if (sbIndex === -1 && isLocal) {
       // Inject ServiceBay (Self)
       services.push({
          name: 'ServiceBay',
          id: 'servicebay',
          active: true,
          status: 'running',
          kubeFile: '',
          kubePath: '',
          yamlFile: null,
          yamlPath: null,
          description: 'ServiceBay Management Interface (Self)',
          ports: [],
          volumes: [],
          labels: { 'servicebay.protected': 'true' },
          type: 'container',
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
