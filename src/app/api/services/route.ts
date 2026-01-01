import { NextResponse } from 'next/server';
import { listServices, saveService } from '@/lib/manager';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  const services = await listServices();
  const config = await getConfig();
  const links = config.externalLinks || [];

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
        monitor: link.monitor
    };
  });

  const mappedServices = services.map(s => ({ ...s, type: 'container' }));

  return NextResponse.json([...mappedLinks, ...mappedServices]);
}

export async function POST(request: Request) {
  const body = await request.json();
  
  // Handle Link Creation
  if (body.type === 'link') {
    const { name, url, description, monitor } = body;
    if (!name || !url) {
        return NextResponse.json({ error: 'Name and URL required' }, { status: 400 });
    }

    const config = await getConfig();
    const newLink: ExternalLink = {
        id: crypto.randomUUID(),
        name,
        url,
        description,
        monitor
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

  await saveService(name, kubeContent, yamlContent, yamlFileName);
  return NextResponse.json({ success: true });
}
