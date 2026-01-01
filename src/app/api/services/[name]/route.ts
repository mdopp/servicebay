import { NextResponse } from 'next/server';
import { getServiceFiles, deleteService, saveService } from '@/lib/manager';
import { getConfig, saveConfig } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import crypto from 'crypto';

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await params;
    
    // Check if it's a link (optional, but GET usually fetches files for editing)
    // If it's a link, we might return link details? 
    // For now, let's assume GET is only for editing container services.
    
    const files = await getServiceFiles(name);
    return NextResponse.json(files);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

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

  await deleteService(name);
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json();

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
          description: body.description || oldLink.description
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
      }
    }
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }

  const { kubeContent, yamlContent, yamlFileName } = body;
   
  await saveService(name, kubeContent, yamlContent, yamlFileName);
  return NextResponse.json({ success: true });
}
