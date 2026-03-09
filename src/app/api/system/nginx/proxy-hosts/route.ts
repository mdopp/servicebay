import { NextResponse } from 'next/server';
import { getConfig, updateConfig, ProxyHostEntry } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface ProxyHostRequest {
    domain: string;
    forwardPort: number;
    forwardHost?: string;
    forwardScheme?: string;
    /** Template name this proxy host belongs to (e.g. "vaultwarden") */
    service?: string;
    /** Service-specific NPM proxy host settings */
    proxyConfig?: {
        allow_websocket_upgrade?: boolean;
        block_exploits?: boolean;
        caching_enabled?: boolean;
        http2_support?: boolean;
        ssl_forced?: boolean;
        /** Custom nginx directives injected into the server block */
        advanced_config?: string;
    };
}

interface NpmResolution {
    /** URL to reach NPM API (from the servicebay backend) */
    apiUrl: string;
    /** Node name where NPM is running */
    nodeName: string;
    /**
     * The IP address of the node where NPM runs.
     * NPM is inside a container, so proxy_pass must use the host IP
     * to reach services in other pods — NOT 127.0.0.1.
     */
    nodeIp: string;
}

/**
 * Resolve the NPM admin API URL and the node IP (for proxy_pass forward_host).
 *
 * NPM runs inside a podman container. From within that container, 127.0.0.1
 * is the pod's own loopback — it can NOT reach services in other pods.
 * The forward_host must be the node's LAN IP so NPM's proxy_pass can
 * reach vaultwarden, immich, home-assistant etc. on their host ports.
 */
async function resolveNpm(nodeHint?: string): Promise<NpmResolution | null> {
    const twinStore = DigitalTwinStore.getInstance();
    const nodeNames = nodeHint ? [nodeHint] : Object.keys(twinStore.nodes);
    if (nodeNames.length === 0) nodeNames.push('Local');

    for (const nodeName of nodeNames) {
        const services = await ServiceManager.listServices(nodeName);
        const nginxService = services.find(s =>
            s.name === 'nginx-web' ||
            (s.name.includes('nginx') && !s.name.startsWith('install-'))
        );
        if (!nginxService?.active) continue;

        const config = await getConfig();
        const adminPort = config.templateSettings?.NGINX_ADMIN_PORT || '8081';

        // For the API call from our backend → NPM: use 127.0.0.1 if local
        const apiHost = nodeName === 'Local' ? '127.0.0.1' : getNodeIp(nodeName, twinStore);

        // For NPM's proxy_pass → other services: always use the node's LAN IP
        const nodeIp = getNodeIp(nodeName, twinStore);

        return {
            apiUrl: `http://${apiHost}:${adminPort}`,
            nodeName,
            nodeIp,
        };
    }
    return null;
}

function getNodeIp(nodeName: string, twinStore: DigitalTwinStore): string {
    const twin = twinStore.nodes[nodeName];
    // Prefer the first non-loopback IP
    if (twin?.nodeIPs?.length) {
        const lanIp = twin.nodeIPs.find(ip => !ip.startsWith('127.'));
        if (lanIp) return lanIp;
        return twin.nodeIPs[0];
    }
    return '127.0.0.1';
}

/**
 * Get an NPM API token using default credentials.
 * NPM default: admin@example.com / changeme
 * After first login the user changes the password, so this only works on fresh installs.
 */
async function getNpmToken(baseUrl: string): Promise<string | null> {
    const credentials = [
        { identity: 'admin@example.com', secret: 'changeme' },
    ];

    for (const cred of credentials) {
        try {
            const res = await fetch(`${baseUrl}/api/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cred),
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                return data.token;
            }
        } catch {
            // try next
        }
    }
    return null;
}

/**
 * Create a proxy host in NPM via its REST API.
 */
async function createProxyHost(baseUrl: string, token: string, host: ProxyHostRequest) {
    const pc = host.proxyConfig || {};
    const body = {
        domain_names: [host.domain],
        forward_host: host.forwardHost,
        forward_port: host.forwardPort,
        forward_scheme: host.forwardScheme || 'http',
        enabled: true,
        // Per-service feature flags
        allow_websocket_upgrade: pc.allow_websocket_upgrade ?? false,
        block_exploits: pc.block_exploits ?? true,
        caching_enabled: pc.caching_enabled ?? false,
        http2_support: pc.http2_support ?? true,
        ssl_forced: pc.ssl_forced ?? true,
        // HSTS defaults
        hsts_enabled: false,
        hsts_subdomains: false,
        // No SSL cert on fresh install — user configures Let's Encrypt via NPM admin
        access_list_id: 0,
        certificate_id: 0,
        meta: { letsencrypt_agree: false, dns_challenge: false },
        // Service-specific nginx directives (timeouts, upload limits, buffering, etc.)
        advanced_config: pc.advanced_config || '',
        locations: [],
    };

    const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `NPM API returned ${res.status}`);
    }
    return await res.json();
}

/**
 * POST: Create proxy hosts in NPM
 * Body: { hosts: [{ domain, forwardPort, forwardHost?, forwardScheme?, proxyConfig? }], node? }
 *
 * If forwardHost is not set, it defaults to the node's LAN IP.
 */
export async function POST(request: Request) {
    try {
        const { hosts, node, publicDomain } = await request.json() as {
            hosts: ProxyHostRequest[];
            node?: string;
            publicDomain?: string;
        };

        if (!hosts?.length) {
            return NextResponse.json({ error: 'No hosts provided' }, { status: 400 });
        }

        const npm = await resolveNpm(node);
        if (!npm) {
            return NextResponse.json({
                error: 'Nginx Proxy Manager not found or not running',
            }, { status: 404 });
        }

        const token = await getNpmToken(npm.apiUrl);
        if (!token) {
            return NextResponse.json({
                error: 'Could not authenticate with NPM. If you changed the default password, configure proxy hosts manually via the admin UI.',
                adminUrl: npm.apiUrl,
            }, { status: 401 });
        }

        const results: { domain: string; success: boolean; error?: string }[] = [];

        for (const host of hosts) {
            // Default forward host = node LAN IP (NPM is in a container,
            // 127.0.0.1 would only reach the NPM pod itself)
            if (!host.forwardHost) {
                host.forwardHost = npm.nodeIp;
            }
            try {
                await createProxyHost(npm.apiUrl, token, host);
                results.push({ domain: host.domain, success: true });
                logger.info('ProxyHosts', `Created proxy host: ${host.domain} → ${host.forwardHost}:${host.forwardPort}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push({ domain: host.domain, success: false, error: msg });
                logger.warn('ProxyHosts', `Failed to create proxy host ${host.domain}: ${msg}`);
            }
        }

        const created = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        // Persist proxy host state and public domain to config
        try {
            const config = await getConfig();
            const existingHosts = config.reverseProxy?.hosts || [];
            const newEntries: ProxyHostEntry[] = hosts.map(h => ({
                domain: h.domain,
                service: h.service || h.domain.split('.')[0],
                forwardPort: h.forwardPort,
                created: results.find(r => r.domain === h.domain)?.success ?? false,
                createdAt: new Date().toISOString(),
            }));
            // Merge: update existing entries by domain, append new ones
            const merged = [...existingHosts];
            for (const entry of newEntries) {
                const idx = merged.findIndex(e => e.domain === entry.domain);
                if (idx >= 0) merged[idx] = entry;
                else merged.push(entry);
            }
            await updateConfig({
                reverseProxy: {
                    ...config.reverseProxy,
                    publicDomain: publicDomain || config.reverseProxy?.publicDomain,
                    hosts: merged,
                },
            });
        } catch (e) {
            logger.warn('ProxyHosts', `Failed to persist proxy host config: ${e}`);
        }

        return NextResponse.json({
            success: failed.length === 0,
            created: created.map(r => r.domain),
            failed: failed.map(r => ({ domain: r.domain, error: r.error })),
            adminUrl: npm.apiUrl,
            node: npm.nodeName,
        });
    } catch (error) {
        console.error('Failed to configure proxy hosts:', error);
        return NextResponse.json({ error: 'Failed to configure proxy hosts' }, { status: 500 });
    }
}
