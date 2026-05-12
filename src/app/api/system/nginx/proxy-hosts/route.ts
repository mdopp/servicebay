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
    /**
     * Exposure profile for the host. `public` triggers an auto Let's
     * Encrypt cert request on this endpoint right after the proxy host
     * is created (best-effort — the install does not fail if the ACME
     * challenge fails; the `cert_request_failure` diagnose probe surfaces
     * the underlying reason). `lan` (or unset) creates the proxy host
     * without a cert. Templates declare a sensible default per
     * subdomain variable in `variables.json`; the wizard's configure
     * step lets the operator override per service.
     */
    exposure?: 'public' | 'lan';
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
            s.name === 'nginx' ||
            (s.name.includes('nginx') && !s.name.startsWith('install-'))
        );
        if (!nginxService?.active) continue;

        // Discover admin port from the running service's port mappings.
        // NPM's admin UI listens on container port 81; find the host port mapped to it.
        // Falls back to config or default if port info is unavailable.
        const svc = nginxService as { ports?: { containerPort?: number; hostPort?: number }[] };
        const adminMapping = svc.ports?.find(p => p.containerPort === 81);
        let adminPort = adminMapping?.hostPort?.toString();
        if (!adminPort) {
            const config = await getConfig();
            adminPort = config.templateSettings?.NGINX_ADMIN_PORT || '81';
        }

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
 * Get an NPM API token. Tries credentials in order:
 * 1. Explicitly provided credentials (from wizard form)
 * 2. Stored credentials from config (config.reverseProxy.npm)
 * 3. NPM default credentials (admin@example.com / changeme)
 */
async function getNpmToken(
    baseUrl: string,
    providedCredentials?: { email: string; password: string },
): Promise<string | null> {
    const candidates: { identity: string; secret: string }[] = [];

    if (providedCredentials) {
        candidates.push({ identity: providedCredentials.email, secret: providedCredentials.password });
    }

    // Stored credentials — set by Settings → Integrations → Reverse Proxy
    try {
        const config = await getConfig();
        const stored = config.reverseProxy?.npm;
        if (stored?.email && stored?.password) {
            candidates.push({ identity: stored.email, secret: stored.password });
        }
    } catch {
        // config not ready — fall through to defaults
    }

    // Always try default credentials last
    candidates.push({ identity: 'admin@example.com', secret: 'changeme' });

    for (const cred of candidates) {
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
 * Request a Let's Encrypt cert from NPM and bind it to the just-created
 * proxy host. Best-effort: returns `{ ok: false, reason }` on every kind
 * of failure (HTTP non-OK, network, malformed response). The caller
 * surfaces the reason in the per-host result so the wizard log shows
 * "cert pending" rather than blowing up the install — the
 * cert_request_failure diagnose probe parses NPM's letsencrypt.log on
 * the next diagnose run and lets the operator click Retry once the
 * underlying cause (DNS / port 80 / CAA) is fixed.
 *
 * NPM's certbot is webroot HTTP-01 by default (see
 * templates/nginx/template.yml). The challenge file is served by NPM on
 * port 80 across every configured server_name, which is why the proxy
 * host MUST exist before issuance — without a server_name match, NPM's
 * default-server rejects the ACME request and certbot times out.
 */
async function requestPublicCert(
    baseUrl: string,
    token: string,
    proxyHostId: number,
    domain: string,
    leEmail: string,
): Promise<{ ok: true; certId: number } | { ok: false; reason: string }> {
    // 1) Create the LE cert in NPM. NPM blocks until the ACME exchange
    //    completes (success or failure), so the timeout here is generous.
    let certId: number;
    try {
        const res = await fetch(`${baseUrl}/api/nginx/certificates`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                provider: 'letsencrypt',
                domain_names: [domain],
                meta: {
                    letsencrypt_email: leEmail,
                    letsencrypt_agree: true,
                    dns_challenge: false,
                },
            }),
            signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { ok: false, reason: `NPM /api/nginx/certificates returned HTTP ${res.status}: ${body.slice(0, 200) || 'no body'}` };
        }
        const data = await res.json() as { id?: number };
        if (typeof data.id !== 'number') {
            return { ok: false, reason: 'NPM accepted the cert request but returned no id.' };
        }
        certId = data.id;
    } catch (e) {
        return { ok: false, reason: `Cert request failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 2) Bind the cert to the proxy host so HTTPS becomes the canonical
    //    URL. Without this step the cert exists in NPM but the proxy
    //    host still serves on port 80 only.
    try {
        const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts/${proxyHostId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                certificate_id: certId,
                ssl_forced: true,
                http2_support: true,
                hsts_enabled: false,
                meta: { letsencrypt_agree: true, dns_challenge: false },
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            // Cert is issued; binding failed. Operator can do this manually
            // in NPM admin → Hosts → Edit. Surface the partial success.
            return { ok: false, reason: `Cert ${certId} issued but binding to proxy host ${proxyHostId} failed (HTTP ${res.status}: ${body.slice(0, 160)}). Open NPM admin → Hosts → Edit → SSL to bind it.` };
        }
    } catch (e) {
        return { ok: false, reason: `Cert ${certId} issued but the bind PUT failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, certId };
}

/**
 * POST: Create proxy hosts in NPM
 * Body: { hosts: [{ domain, forwardPort, forwardHost?, forwardScheme?, proxyConfig? }], node? }
 *
 * If forwardHost is not set, it defaults to the node's LAN IP.
 */
export async function POST(request: Request) {
    try {
        const { hosts, node, publicDomain, npmCredentials } = await request.json() as {
            hosts: ProxyHostRequest[];
            node?: string;
            publicDomain?: string;
            npmCredentials?: { email: string; password: string };
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

        const token = await getNpmToken(npm.apiUrl, npmCredentials);
        if (!token) {
            return NextResponse.json({
                error: 'Could not authenticate with NPM. Please provide your NPM admin credentials.',
                adminUrl: npm.apiUrl,
                needsCredentials: true,
            }, { status: 401 });
        }

        // ACME registration email — needed when any host has
        // `exposure: 'public'`. Falls back to the stored NPM admin email
        // (the wizard hoists operatorEmail into both fields).
        const config = await getConfig();
        const leEmail = config.reverseProxy?.npm?.email;

        const results: { domain: string; success: boolean; error?: string; certIssued?: boolean; certError?: string }[] = [];

        for (const host of hosts) {
            // Default forward host = node LAN IP (NPM is in a container,
            // 127.0.0.1 would only reach the NPM pod itself)
            if (!host.forwardHost) {
                host.forwardHost = npm.nodeIp;
            }
            let createdHost: { id?: number } | null = null;
            try {
                createdHost = await createProxyHost(npm.apiUrl, token, host);
                results.push({ domain: host.domain, success: true });
                logger.info('ProxyHosts', `Created proxy host: ${host.domain} → ${host.forwardHost}:${host.forwardPort} (exposure=${host.exposure ?? 'lan'})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push({ domain: host.domain, success: false, error: msg });
                logger.warn('ProxyHosts', `Failed to create proxy host ${host.domain}: ${msg}`);
                continue;
            }

            // Auto-cert for public-exposure hosts. Best-effort: install
            // continues regardless of ACME outcome — the diagnose probe
            // (`cert_request_failure`) is the recovery path.
            if (host.exposure === 'public') {
                if (!leEmail) {
                    const reason = 'No ACME registration email configured (set reverseProxy.npm.email in Settings → Integrations); skipped cert request.';
                    results[results.length - 1].certError = reason;
                    logger.warn('ProxyHosts', `Skip cert for ${host.domain}: ${reason}`);
                } else if (typeof createdHost?.id !== 'number') {
                    results[results.length - 1].certError = 'NPM did not return a proxy host id; cannot bind a cert without it.';
                } else {
                    const certResult = await requestPublicCert(
                        npm.apiUrl,
                        token,
                        createdHost.id,
                        host.domain,
                        leEmail,
                    );
                    if (certResult.ok) {
                        results[results.length - 1].certIssued = true;
                        logger.info('ProxyHosts', `Issued + bound LE cert ${certResult.certId} for ${host.domain}`);
                    } else {
                        results[results.length - 1].certError = certResult.reason;
                        logger.warn('ProxyHosts', `Cert request failed for ${host.domain}: ${certResult.reason}`);
                    }
                }
            }
        }

        const created = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        // Persist proxy host state and public domain to config
        try {
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
            // Per-host cert outcomes — present only for hosts whose
            // request body had `exposure: 'public'`. Successful issuance
            // → `certIssued: true`; any failure → `certError: <reason>`.
            // The wizard surfaces successes/failures as a short summary;
            // the cert_request_failure diagnose probe is the recovery
            // path for the failure case.
            certs: results
                .filter(r => r.certIssued || r.certError)
                .map(r => ({ domain: r.domain, issued: r.certIssued === true, error: r.certError })),
            adminUrl: npm.apiUrl,
            node: npm.nodeName,
        });
    } catch (error) {
        logger.error('api:nginx:proxy-hosts', 'Failed to configure proxy hosts', error);
        return NextResponse.json({ error: 'Failed to configure proxy hosts' }, { status: 500 });
    }
}
