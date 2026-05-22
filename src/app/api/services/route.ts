import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getConfig, saveConfig, ExternalLink } from '@/lib/config';
import { HealthStore } from '@/lib/health/store';
import { listNodes } from '@/lib/nodes';
import { buildExternalLinkPorts, normalizeExternalTargets } from '@/lib/network/externalLinks';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const ListQuery = z.object({
  scope: z.string().optional(),
  node: z.string().optional(),
});

const parseIpTargets = (input: unknown, fallback: string[] = []) => {
    const parsed = normalizeExternalTargets(input);
    if (parsed.length > 0) {
        return parsed;
    }
    return fallback;
};


const mapExternalLinks = (links: ExternalLink[]) => {
    const checks = HealthStore.getChecks();

    type LinkStatus = 'ok' | 'fail' | 'external';

    return links.map(link => {
        const check = checks.find(c => c.name === `Link: ${link.name}`);
        const lastResult = check ? HealthStore.getLastResult(check.id) : null;
        const statusLabel: LinkStatus = lastResult ? lastResult.status : 'external';
        const isActive = statusLabel === 'ok' || statusLabel === 'external';
        const activeState = isActive ? 'active' : 'inactive';
        const ipTargets = normalizeExternalTargets(link.ipTargets || []);
        const graphPorts = (link.ports && link.ports.length > 0) ? link.ports : buildExternalLinkPorts(ipTargets);
        const ports = graphPorts.map(port => ({
            host: port.host !== undefined ? String(port.host) : '',
            container: port.container !== undefined ? String(port.container) : '',
            hostIp: port.hostIp,
            protocol: port.protocol,
            source: port.source
        }));

        return {
            name: link.name,
            active: isActive,
            status: statusLabel,
            activeState,
            subState: statusLabel,
            kubePath: '',
            yamlPath: null,
            ports,
            volumes: [],
            type: 'link',
            url: link.url,
            description: link.description,
            id: link.id,
            monitor: Boolean(link.monitor),
            ipTargets,
            labels: {},
            nodeName: 'Global'
        };
    });
};

export const GET = withApiHandler<undefined, z.infer<typeof ListQuery>>(
  { query: ListQuery },
  async ({ query }) => {
  try {
    const scope = query.scope;

    if (scope === 'links') {
        const config = await getConfig();
        const links = config.externalLinks || [];
        return NextResponse.json(mapExternalLinks(links));
    }

    const nodeName = query.node;
    const isLocal = !nodeName || nodeName === 'Local';
    
    // Start fetching config immediately
    const configPromise = getConfig();

    const servicesPromise = (async () => {
        const targetNode = (!nodeName || nodeName === 'Local') ? 'Local' : nodeName;
        return ServiceManager.listServices(targetNode);
    })();

    // Helper to determine if we should inject global services (Gateway, Links, Self)
    const shouldInjectGlobals = async () => {
        if (isLocal) return true;
        // If "Local" is unused, we inject on the Default node
        const nodes = await listNodes();
        const defaultNode = nodes.find(n => n.Default);
        return defaultNode && defaultNode.Name === nodeName;
    };

    const isDefaultOrLocal = await shouldInjectGlobals();

    // Wait for services and config
    const [services, configResolved] = await Promise.all([servicesPromise, configPromise]);
    
    // Use resolved config
    const config = configResolved;

    // Only fetch links and gateway if we are on the local or default node
    const mappedLinks = isDefaultOrLocal ? mapExternalLinks(config.externalLinks || []) : [];


    // Gateway Info from Config
    const gatewayService = [];
  if (isDefaultOrLocal) {
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

    // Check if Nginx (Reverse Proxy) is present using the new flag
    // We prioritize candidates that are explicitly marked as Reverse Proxy
    const proxyCandidates = services.filter(s => s.isReverseProxy);

    // Debug logging for Nginx detection
    logger.debug('api:services:get', `Listing services for ${nodeName}: found ${proxyCandidates.length} proxy candidates`, proxyCandidates.map(c => `${c.name} (${c.status})`));

    if (proxyCandidates.length > 0) {
        // Sort candidates: Active first, then by meaningfulness
        proxyCandidates.sort((a, b) => {
             if (a.active && !b.active) return -1;
             if (!a.active && b.active) return 1;
             return 0;
        });

        const bestCandidate = proxyCandidates[0];
        
        // Remove ALL proxy candidates from the main list to avoid duplication
        for (const c of proxyCandidates) {
            const idx = services.findIndex(s => s === c);
            if (idx !== -1) services.splice(idx, 1);
        }

        // Add Best Candidate as Reverse Proxy with Enhanced Gateway Structure
        const targetNode = (!nodeName || nodeName === 'Local') ? 'Local' : nodeName;
        const nodeTwin = DigitalTwinStore.getInstance().nodes[targetNode];
        const proxyRoutes = nodeTwin?.proxyRoutes || [];

        // Transform routes to "Nginx Server"-like structure (Compatibility Mode for UI)
        const formattedServers = proxyRoutes.map(route => ({
             server_name: [route.host],
             listen: route.ssl ? ["443 ssl", "80"] : ["80"],
             locations: [{
                 path: "/",
                 proxy_pass: `http://${route.targetService}:${route.targetPort}`
             }],
             _agent_data: true,
             _ssl: route.ssl,
             _targetPort: route.targetPort
        }));

        const flatGateway = { ...bestCandidate };
        // Ensure strictly flat structure by removing any potential nested service objects if they exist
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (flatGateway as any).service; 

        // Insert as Special Gateway Type but extending the underlying service
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (services as any[]).unshift({
            ...flatGateway, // Flat structure: Inherit all service properties (ports, volumes, etc.)
            // Flattened Gateway Object (V4.1)
            type: 'gateway', // Override Type
            name: 'Reverse Proxy', // Override Name
            id: bestCandidate.name, // Ensure ID is set
            servers: formattedServers // Extension Data
        });

  } else if (isDefaultOrLocal) {
      // Inject virtual service
      services.push({
          name: 'Reverse Proxy',
          id: 'nginx',
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
          node: nodeName || 'Local'
      });
  }

  // Check if ServiceBay is present (Self-Management)
  const isServiceBayPresent = services.some(s => s.isServiceBay);

  if (!isServiceBayPresent && isDefaultOrLocal) {
       // Inject ServiceBay (Self) if missing
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
          isServiceBay: true, // Mark virtual injection too
          node: nodeName || 'Local' 
      });
  }

    // Allow services to override type (e.g. Gateway/Proxy)
    const mappedServices = services.map(s => ({ type: 'container', ...s }));

    return NextResponse.json([...mappedLinks, ...gatewayService, ...mappedServices]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('api:services:get', 'Failed to list services', error);
    return NextResponse.json(
        { error: msg || 'Internal Server Error' },
        { status: 500 }
    );
  }
});

const CreateQuery = z.object({
  node: z.string().optional(),
  stream: z.string().optional(),
});

export const POST = withApiHandler<undefined, z.infer<typeof CreateQuery>>(
  { query: CreateQuery },
  async ({ request, query }) => {
  const body = await request.json();
  const nodeName = query.node;

  const targetNode = (!nodeName || nodeName === 'Local') ? 'Local' : nodeName;
  
  // Handle Link Creation
  if (body.type === 'link') {
    const { name, url, description, monitor } = body;
    if (!name || !url) {
        return NextResponse.json({ error: 'Name and URL required' }, { status: 400 });
    }

    const config = await getConfig();
    const parsedTargets = parseIpTargets(body.ipTargets);
    const portMappings = buildExternalLinkPorts(parsedTargets);

    const newLink: ExternalLink = {
        id: crypto.randomUUID(),
        name,
        url,
        description,
        monitor,
        ipTargets: parsedTargets,
        ports: portMappings
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
        HealthStore.saveCheck(check);
    }

    return NextResponse.json({ success: true });
  }

  // Handle Container Creation
  const { name, kubeContent, yamlContent, yamlFileName, extraFiles, postDeployScript, postDeployEnv, migrations } = body;

  if (!name || !kubeContent || !yamlContent || !yamlFileName) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  // Validate the Pod manifest before the agent write. Catches typoed
  // apiVersion / missing spec.containers / cross-volume mismatches before
  // they produce a permanently-failed unit nobody can debug from the UI.
  const { validatePodManifest } = await import('@/lib/services/podSchema');
  const validation = validatePodManifest(yamlContent);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: 'invalid Pod manifest',
        path: validation.error?.path,
        detail: validation.error?.message,
      },
      { status: 400 },
    );
  }

  // Streaming mode: return progress events as they happen
  if (query.stream === '1') {
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    let writerClosed = false;
    const safeWrite = async (payload: unknown) => {
      if (writerClosed) return;
      try {
        await writer.write(encoder.encode(JSON.stringify(payload) + '\n'));
      } catch {
        // Client aborted — mark closed so subsequent writes are no-ops
        // instead of triggering unhandledRejection.
        writerClosed = true;
      }
    };

    // Keepalive ping. Templates with long silent post-deploy phases
    // (e.g. immich's wait_pod_running can be idle 10 min on a cold
    // first-boot image pull) would otherwise let undici's default
    // 5-min bodyTimeout close the install runner's fetch with
    // `terminated`, triggering a phantom retry while the install is
    // actually still progressing fine. The runner ignores unknown
    // event types, so emitting `{type: "ping"}` every 30 s keeps the
    // stream warm without surfacing to the UI.
    const KEEPALIVE_INTERVAL_MS = 30_000;
    const keepalive = setInterval(() => {
      void safeWrite({ type: 'ping' });
    }, KEEPALIVE_INTERVAL_MS);

    (async () => {
      try {
        await ServiceManager.deployKubeService(
          targetNode,
          name,
          kubeContent,
          yamlContent,
          yamlFileName,
          extraFiles,
          (message) => { void safeWrite({ type: 'progress', message }); },
          postDeployScript,
          postDeployEnv,
          migrations,
        );
        await safeWrite({ type: 'complete', success: true });
      } catch (e) {
        await safeWrite({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(keepalive);
        if (!writerClosed) {
          try { await writer.close(); } catch { /* already closed */ }
        }
      }
    })();

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      },
    });
  }

  await ServiceManager.deployKubeService(
    targetNode,
    name,
    kubeContent,
    yamlContent,
    yamlFileName,
    extraFiles,
    undefined,
    postDeployScript,
    postDeployEnv,
    migrations,
  );
  return NextResponse.json({ success: true });
});
