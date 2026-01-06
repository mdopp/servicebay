import { NextResponse } from 'next/server';
import { getServiceFiles, deleteService, saveService, updateServiceDescription } from '@/lib/manager';
import { getConfig, saveConfig } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import { listNodes } from '@/lib/nodes';
import crypto from 'crypto';

async function getConnection(request: Request) {
    const { searchParams } = new URL(request.url);
    const nodeName = searchParams.get('node');
    if (nodeName) {
        const nodes = await listNodes();
        return nodes.find(n => n.Name === nodeName);
    }
    return undefined;
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name: rawName } = await params;
    const name = decodeURIComponent(rawName);
    const connection = await getConnection(request);
    
    // Check if it's a link (optional, but GET usually fetches files for editing)
    // If it's a link, we might return link details? 
    // For now, let's assume GET is only for editing container services.
    
    const files = await getServiceFiles(name, connection);
    return NextResponse.json(files);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const connection = await getConnection(request);

  // Check if it's a link
  const config = await getConfig();
  if (config.externalLinks) {
    const linkIndex = config.externalLinks.findIndex(l => l.name === name || l.id === name);
    if (linkIndex !== -1) {
        const link = config.externalLinks[linkIndex];
        config.externalLinks.splice(linkIndex, 1);
        await saveConfig(config);
        
        // Remove monitor check if exists
        const checks = MonitoringStore.getChecks();
        const check = checks.find(c => c.name === `Link: ${link.name}`);
        if (check) {
            MonitoringStore.deleteCheck(check.id);
        }
        
        return NextResponse.json({ success: true });
    }
  }

  await deleteService(name, connection);
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const body = await request.json();
  const connection = await getConnection(request);

  // Check if it's a link update
  if (body.type === 'link') {
    const config = await getConfig();
    if (config.externalLinks) {
      const linkIndex = config.externalLinks.findIndex(l => l.name === name || l.id === name);
      if (linkIndex !== -1) {
        // Update existing link
        const oldLink = config.externalLinks[linkIndex];
        const newName = body.name || oldLink.name;
        
        config.externalLinks[linkIndex] = {
          ...oldLink,
          name: newName,
          url: body.url || oldLink.url,
          description: body.description || oldLink.description,
          monitor: body.monitor !== undefined ? body.monitor : oldLink.monitor,
          ip_targets: body.ip_targets !== undefined ? body.ip_targets : oldLink.ip_targets
        };
        
        await saveConfig(config);

        // Update monitor if needed
        if (body.monitor !== undefined) {
             const checks = MonitoringStore.getChecks();
             const checkName = `Link: ${oldLink.name}`; // Use old name to find
             const check = checks.find(c => c.name === checkName);
             
             if (body.monitor) {
                 if (check) {
                     // Update check
                     MonitoringStore.saveCheck({
                         ...check,
                         name: `Link: ${newName}`,
                         target: body.url,
                         interval: 60
                     });
                 } else {
                     // Create check
                     MonitoringStore.saveCheck({
                         id: crypto.randomUUID(),
                         name: `Link: ${newName}`,
                         type: 'http',
                         target: body.url,
                         interval: 60,
                         enabled: true,
                         created_at: new Date().toISOString(),
                         httpConfig: { expectedStatus: 200 }
                     });
                 }
             } else {
                 if (check) {
                     MonitoringStore.deleteCheck(check.id);
                 }
             }
        }

        return NextResponse.json({ success: true });
      } else {
        // Link does not exist, create it (Promote Virtual Node to External Link)
        if (!config.externalLinks) config.externalLinks = [];
        
        config.externalLinks.push({
            id: crypto.randomUUID(),
            name: name,
            url: body.url,
            description: body.description || '',
            monitor: body.monitor || false,
            ip_targets: body.ip_targets || []
        });
        
        await saveConfig(config);

        // Add monitor if requested
        if (body.monitor) {
             MonitoringStore.saveCheck({
                 id: crypto.randomUUID(),
                 name: `Link: ${name}`,
                 type: 'http',
                 target: body.url,
                 interval: 60,
                 enabled: true,
                 created_at: new Date().toISOString(),
                 httpConfig: { expectedStatus: 200 }
             });
        }
        
        return NextResponse.json({ success: true });
      }
    }
    // If config.externalLinks was undefined but we created it above, we returned.
    // If type was link but somehow failed logic? No, the else block handles it.
  }

  // Handle Description Update for Managed Service
  if (body.description !== undefined && !body.kubeContent) {
      try {
          await updateServiceDescription(name, body.description, connection);
          return NextResponse.json({ success: true });
      } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          return NextResponse.json({ error: message }, { status: 500 });
      }
  }

  const { kubeContent, yamlContent, yamlFileName } = body;
   
  await saveService(name, kubeContent, yamlContent, yamlFileName, connection);
  return NextResponse.json({ success: true });
}
