import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { MonitoringStore } from '@/lib/monitoring/store';
import { buildExternalLinkPorts, normalizeExternalTargets } from '@/lib/network/externalLinks';
import { ServiceName } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import crypto from 'crypto';

const parseIpTargets = (input: unknown, fallback: string[] = []) => {
  const parsed = normalizeExternalTargets(input);
  if (parsed.length > 0) {
    return parsed;
  }
  return fallback;
};

function getNodeName(request: Request): string {
    const { searchParams } = new URL(request.url);
    return searchParams.get('node') || 'Local';
}

// Decode + validate the [name] segment. External links can use a UUID or a
// human-readable label; managed services flow into shell commands so they
// must satisfy ServiceName. We accept any non-empty string here and let the
// caller decide how strict to be (link lookup vs. shell-bound action).
async function decodeName(params: Promise<{ name: string }>): Promise<string | null> {
  const resolved = await params;
  const raw = resolved?.name ?? '';
  try { return decodeURIComponent(raw); } catch { return null; }
}

function ensureServiceName(name: string): { ok: true; value: string } | { ok: false; response: NextResponse } {
  const check = ServiceName.safeParse(name);
  if (!check.success) {
    return { ok: false, response: NextResponse.json({ error: 'invalid name' }, { status: 400 }) };
  }
  return { ok: true, value: check.data };
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const decoded = await decodeName(params);
    if (decoded === null) return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
    const guard = ensureServiceName(decoded);
    if (!guard.ok) return guard.response;
    const nodeName = getNodeName(request);

    const files = await ServiceManager.getServiceFiles(nodeName, guard.value);
    return NextResponse.json(files);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const decoded = await decodeName(params);
  if (decoded === null) return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
  const nodeName = getNodeName(request);

  // External-link branch: name may be a UUID or label, no shell interpolation. Match before strict validation.
  const config = await getConfig();
  if (config.externalLinks) {
    const linkIndex = config.externalLinks.findIndex(l => l.name === decoded || l.id === decoded);
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

  // Managed service deletion: shell-bound, must satisfy ServiceName.
  const guard = ensureServiceName(decoded);
  if (!guard.ok) return guard.response;
  await ServiceManager.deleteService(nodeName, guard.value);
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const decoded = await decodeName(params);
  if (decoded === null) return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
  const name = decoded;
  const body = await request.json();
  const nodeName = getNodeName(request);

  // Check if it's a link update
  if (body.type === 'link') {
    const config = await getConfig();
    if (config.externalLinks) {
      const linkIndex = config.externalLinks.findIndex(l => l.name === name || l.id === name);
      if (linkIndex !== -1) {
        // Update existing link
        const oldLink = config.externalLinks[linkIndex];
        const newName = body.name || oldLink.name;

        let updatedIpTargets = oldLink.ipTargets || [];
        if (body.ipTargets !== undefined) {
          updatedIpTargets = parseIpTargets(body.ipTargets, updatedIpTargets);
        }
        const updatedPorts = updatedIpTargets.length > 0 ? buildExternalLinkPorts(updatedIpTargets) : (oldLink.ports || []);

        config.externalLinks[linkIndex] = {
          ...oldLink,
          name: newName,
          url: body.url || oldLink.url,
          description: body.description || oldLink.description,
          monitor: body.monitor !== undefined ? body.monitor : oldLink.monitor,
          ipTargets: updatedIpTargets,
          ports: updatedPorts
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

        const parsedTargets = parseIpTargets(body.ipTargets);
        const portMappings = buildExternalLinkPorts(parsedTargets);

        const newLink: ExternalLink = {
          id: crypto.randomUUID(),
          name: name,
          url: body.url,
          description: body.description || '',
          monitor: body.monitor || false,
          ipTargets: parsedTargets,
          ports: portMappings
        };
        config.externalLinks.push(newLink);

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
  }

  // Beyond this point we touch shell-bound managed services.
  const guard = ensureServiceName(name);
  if (!guard.ok) return guard.response;
  const safeName = guard.value;

  // Handle Description Update for Managed Service
  if (body.description !== undefined && !body.kubeContent) {
      try {
          await ServiceManager.updateServiceDescription(nodeName, safeName, body.description);
          return NextResponse.json({ success: true });
      } catch (e) {
          return apiError(e, { tag: 'api:services:update', status: 500 });
      }
  }

  const { kubeContent, yamlContent, yamlFileName } = body;

  if (!kubeContent || !yamlContent) {
      return NextResponse.json({ error: 'kubeContent and yamlContent are required' }, { status: 400 });
  }

  await ServiceManager.saveService(nodeName, safeName, kubeContent, yamlContent, yamlFileName);
  return NextResponse.json({ success: true });
}
