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
     * Exposure profile for the host. Three tiers:
     *
     * - `public` — auto LE cert + open access. Reachable from anywhere
     *   on the internet. Use for end-user-facing services (Authelia
     *   portal, Vaultwarden, files, photos, …).
     * - `internal` — auto LE cert + NPM IP-allowlist to LAN-CIDR. The
     *   domain has a public DNS record so LE HTTP-01 can validate (the
     *   ACME-challenge location bypasses the allowlist inside NPM by
     *   design), but every other path is denied from non-LAN IPs.
     *   Use for admin consoles that need real HTTPS (so Authelia
     *   forward-auth works) but should never be hit from outside
     *   — ldap, dns, sync, zwave.
     * - `lan` (or unset) — no cert, NPM IP-allowlist binding only.
     *   The host serves plain HTTP. Authelia forward-auth gating
     *   does NOT work here (Authelia rejects http scheme on
     *   /api/authz/auth-request — see forwardAuth.ts).
     *
     * Cert request is best-effort for both `public` and `internal`:
     * install does not fail on ACME hiccups; `cert_request_failure`
     * diagnose probe surfaces the reason.
     *
     * Templates declare a sensible default per subdomain variable in
     * `variables.json`; the wizard's configure step lets the operator
     * override per service.
     */
    exposure?: 'public' | 'internal' | 'lan';
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

/** Name we use for the auto-managed LAN-only access list in NPM. The
 *  GET-then-POST flow keys off this exact string, so don't change it
 *  without a migration plan — renaming would orphan the existing list
 *  and create a duplicate. */
const LAN_ACCESS_LIST_NAME = 'ServiceBay LAN only';

/**
 * Derive a /24 CIDR from a node IP. 192.168.178.100 → 192.168.178.0/24.
 * Operators on non-/24 LANs can edit the access list manually in NPM
 * admin — most home/SOHO networks are /24, so this is the right default.
 */
function lanCidrFromIp(ip: string): string | null {
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    if (!m) return null;
    return `${m[1]}.${m[2]}.${m[3]}.0/24`;
}

/**
 * Ensure NPM has a "ServiceBay LAN only" access list configured for the
 * detected LAN /24, returning its id. Create-if-missing, idempotent
 * across reinstalls. Returns null on any error so the caller can fall
 * back to the previous open behaviour rather than blowing up the install.
 *
 * Used by the proxy-host loop to auto-restrict any host whose
 * `exposure: 'lan'` meta says it shouldn't be reachable from the
 * internet. The wizard's "Access Restrictions (recommended)" manual
 * instruction was the bandaid for this gap.
 */
async function ensureLanAccessList(baseUrl: string, token: string, nodeIp: string): Promise<number | null> {
    const cidr = lanCidrFromIp(nodeIp);
    if (!cidr) {
        logger.warn('ProxyHosts', `Could not derive LAN CIDR from node IP ${nodeIp}; skipping access-list setup.`);
        return null;
    }

    // 1) Look for an existing list by name. expand=clients gives us the
    //    rule list so we can detect drift and patch instead of duplicating.
    try {
        const listRes = await fetch(`${baseUrl}/api/nginx/access-lists?expand=clients`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (listRes.ok) {
            const lists = (await listRes.json()) as Array<{
                id: number;
                name: string;
                clients?: Array<{ address: string; directive: string }>;
            }>;
            const existing = Array.isArray(lists) ? lists.find(l => l.name === LAN_ACCESS_LIST_NAME) : undefined;
            if (existing) return existing.id;
        }
    } catch (e) {
        logger.warn('ProxyHosts', `LAN access-list lookup failed: ${e instanceof Error ? e.message : String(e)}`);
        // fall through to create — worst case we'll get a duplicate-name 400
    }

    // 2) Create the list. nginx access rules are evaluated top-to-bottom
    //    and first-match-wins; allow LAN + localhost, then explicit
    //    deny-all so the rejection is unambiguous in NPM's logs.
    try {
        const createRes = await fetch(`${baseUrl}/api/nginx/access-lists`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                name: LAN_ACCESS_LIST_NAME,
                satisfy_any: false,
                pass_auth: false,
                items: [],
                clients: [
                    { address: cidr,         directive: 'allow' },
                    { address: '127.0.0.1',  directive: 'allow' },
                    { address: 'all',        directive: 'deny' },
                ],
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!createRes.ok) {
            const body = await createRes.text().catch(() => '');
            logger.warn('ProxyHosts', `Failed to create LAN access list: HTTP ${createRes.status} ${body.slice(0, 200)}`);
            return null;
        }
        const data = (await createRes.json()) as { id?: number };
        if (typeof data.id !== 'number') return null;
        logger.info('ProxyHosts', `Created NPM access list "${LAN_ACCESS_LIST_NAME}" (id=${data.id}) allowing ${cidr} + localhost`);
        return data.id;
    } catch (e) {
        logger.warn('ProxyHosts', `LAN access-list create failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/**
 * Look up an existing NPM proxy host by domain. Returns the proxy
 * host object (with `id`) when found, `null` when not present. Used
 * by `createProxyHost` so a second create-attempt for the same
 * domain isn't reported as a failure when the host already exists
 * from a prior install / re-trigger of the provisioner.
 */
async function findProxyHostByDomain(baseUrl: string, token: string, domain: string): Promise<{ id: number } | null> {
    try {
        const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts?expand=owner,access_list,certificate`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const list = (await res.json()) as Array<{ id: number; domain_names?: string[] }>;
        const existing = list.find(h => Array.isArray(h.domain_names) && h.domain_names.includes(domain));
        return existing ? { id: existing.id } : null;
    } catch {
        return null;
    }
}

/**
 * Create a proxy host in NPM via its REST API.
 *
 * Idempotent: if NPM already has a host for this domain we return its
 * existing record instead of POSTing a duplicate. The apex/www route
 * provisioner runs from several places (install runner, AdGuard
 * post-deploy hook, the 60-s post-boot timer), so a second call
 * frequently lands on a domain that's already configured — without
 * this guard NPM 400s and `config.reverseProxy.hosts[].created`
 * flips back to `false`, surfacing as a false-positive in the
 * `proxy_route_missing` diagnose probe.
 */
async function createProxyHost(baseUrl: string, token: string, host: ProxyHostRequest, accessListId: number = 0) {
    const existing = await findProxyHostByDomain(baseUrl, token, host.domain);
    if (existing) {
        return existing;
    }

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
        // SSL cert is bound after creation (via requestPublicCert) for
        // public-exposure hosts. access_list_id wires NPM's IP-based
        // gate; lan-exposure hosts get the auto-created
        // "ServiceBay LAN only" list, public hosts stay open (0).
        access_list_id: accessListId,
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
        // Belt-and-braces: NPM can race with us between the pre-check
        // and the POST (two concurrent provisioners), so a 400 here
        // might still mean "exists" rather than an actual rejection.
        // Look it up once more before reporting the failure.
        if (res.status === 400) {
            const racedExisting = await findProxyHostByDomain(baseUrl, token, host.domain);
            if (racedExisting) {
                return racedExisting;
            }
        }
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
/**
 * Look for an existing, still-valid Let's Encrypt cert that already
 * covers `domain`. Returns its id when found so the caller can bind
 * the proxy host without going to ACME — critical for re-installs
 * where the cert files survived in `letsencrypt/` (via #534's
 * auto-restore) and NPM's DB has the cert rows after replay, but the
 * install runner used to ALWAYS request fresh certs anyway and burn
 * through Let's Encrypt's "5 identical certs / week" rate limit
 * within minutes of a re-install. See #566.
 *
 * Returns `null` when no usable cert exists, falling back to the
 * legacy "request a fresh one" path. A cert that expires in less than
 * `EXPIRY_MIN_DAYS` is treated as no-match so NPM's nightly renew
 * doesn't race the install — we'd rather request fresh now than
 * inherit something about to flip red on the operator.
 */
const EXPIRY_MIN_DAYS = 14;
async function findReusableCert(
    baseUrl: string,
    token: string,
    domain: string,
): Promise<number | null> {
    try {
        const res = await fetch(`${baseUrl}/api/nginx/certificates?expand=owner`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const certs = await res.json() as Array<{
            id: number;
            provider: string;
            domain_names: string[];
            expires_on: string | null;
        }>;
        if (!Array.isArray(certs)) return null;
        const cutoff = Date.now() + EXPIRY_MIN_DAYS * 24 * 60 * 60 * 1000;
        // Newest-first so multiple matches pick the freshest cert (NPM
        // doesn't dedupe by domain on its side; an operator who hit
        // the rate limit and ran an old install too could have two
        // certificate rows for the same domain. We want the one with
        // the latest valid expires_on).
        const candidates = certs
            .filter(c => c.provider === 'letsencrypt')
            .filter(c => Array.isArray(c.domain_names) && c.domain_names.includes(domain))
            .filter(c => c.expires_on && Date.parse(c.expires_on) > cutoff)
            .sort((a, b) => Date.parse(b.expires_on!) - Date.parse(a.expires_on!));
        return candidates[0]?.id ?? null;
    } catch {
        return null;
    }
}

async function requestPublicCert(
    baseUrl: string,
    token: string,
    proxyHostId: number,
    domain: string,
    leEmail: string,
): Promise<{ ok: true; certId: number; reused?: boolean } | { ok: false; reason: string }> {
    // 0) Reuse path (#566). If NPM already has a valid LE cert covering
    //    `domain`, bind that instead of asking ACME for a new one — the
    //    LE "5 identical / week" rate limit otherwise breaks every
    //    re-install where the cert files were restored by #534.
    const reusable = await findReusableCert(baseUrl, token, domain);
    let certId: number;
    if (reusable !== null) {
        logger.info('ProxyHosts', `Reusing existing NPM cert #${reusable} for ${domain} (avoids LE rate-limit churn on re-installs)`);
        certId = reusable;
    } else {
    // 1) Create the LE cert in NPM. NPM blocks until the ACME exchange
    //    completes (success or failure), so the timeout here is generous.
    //
    // Schema note: recent NPM (master) tightened the certificate `meta`
    // schema with `additionalProperties: false` and dropped both
    // `letsencrypt_email` and `letsencrypt_agree`. The ACME email now
    // comes from the owner user's account (NPM reads `user.email` on
    // the authenticated principal), which our bootstrap step already
    // sets via PUT /api/users/1. Sending the legacy fields makes NPM
    // 400 with "data/meta must NOT have additional properties". The
    // `leEmail` param stays only as a precondition gate — callers skip
    // cert issuance when it isn't set, because "no admin email" means
    // NPM can't register with Let's Encrypt regardless of payload.
    void leEmail;
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
                meta: { dns_challenge: false },
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
    return { ok: true, certId, reused: reusable !== null };
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

        // Auto-create the "ServiceBay LAN only" access list once if any
        // incoming host wants it. Doing this up front (not per-host) means
        // we hit NPM's access-list endpoint at most twice per install
        // batch instead of N times. `lanAccessListId === null` falls back
        // to the previous open behaviour for that subset of hosts so the
        // install doesn't fail just because the access-list creation
        // hiccupped — the diagnose UI is the recovery path.
        //
        // `lan` AND `internal` both bind the LAN access list; `internal`
        // additionally requests a public LE cert (the ACME challenge
        // location bypasses the allowlist by design inside NPM).
        const needsLanList = hosts.some(h => h.exposure === 'lan' || h.exposure === 'internal');
        const lanAccessListId = needsLanList
            ? await ensureLanAccessList(npm.apiUrl, token, npm.nodeIp)
            : null;

        const results: { domain: string; success: boolean; error?: string; certIssued?: boolean; certError?: string; lanRestricted?: boolean }[] = [];

        for (const host of hosts) {
            // Default forward host = node LAN IP (NPM is in a container,
            // 127.0.0.1 would only reach the NPM pod itself)
            if (!host.forwardHost) {
                host.forwardHost = npm.nodeIp;
            }
            const wantsLanList = host.exposure === 'lan' || host.exposure === 'internal';
            const accessListId = wantsLanList && lanAccessListId !== null ? lanAccessListId : 0;
            let createdHost: { id?: number } | null = null;
            try {
                createdHost = await createProxyHost(npm.apiUrl, token, host, accessListId);
                results.push({ domain: host.domain, success: true, lanRestricted: accessListId !== 0 });
                logger.info('ProxyHosts', `Created proxy host: ${host.domain} → ${host.forwardHost}:${host.forwardPort} (exposure=${host.exposure ?? 'lan'}${accessListId !== 0 ? ', LAN-only via access list' : ''})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push({ domain: host.domain, success: false, error: msg });
                logger.warn('ProxyHosts', `Failed to create proxy host ${host.domain}: ${msg}`);
                continue;
            }

            // Auto-cert for public AND internal hosts. Best-effort:
            // install continues regardless of ACME outcome — the
            // diagnose probe (`cert_request_failure`) is the recovery
            // path. Internal hosts get a real cert too so Authelia
            // forward-auth (which requires https scheme) works.
            if (host.exposure === 'public' || host.exposure === 'internal') {
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
                        if (certResult.reused) {
                            logger.info('ProxyHosts', `Reused existing LE cert ${certResult.certId} for ${host.domain} (re-install survived #534 cert-archive — no ACME call needed)`);
                        } else {
                            logger.info('ProxyHosts', `Issued + bound LE cert ${certResult.certId} for ${host.domain}`);
                        }
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
                // Persist exposure so downstream consumers (domain
                // health checks, diagnose probes, letsdebug filter)
                // can tell `lan` from `public` without trying to
                // re-derive it from the domain string — which doesn't
                // work now that LAN-only services live on the public
                // domain too.
                exposure: h.exposure,
            }));
            // Merge: update existing entries by domain, append new
            // ones. Preserve the previous `exposure` value when the
            // incoming entry doesn't carry one (older clients).
            const merged = [...existingHosts];
            for (const entry of newEntries) {
                const idx = merged.findIndex(e => e.domain === entry.domain);
                if (idx >= 0) {
                    merged[idx] = { ...merged[idx], ...entry, exposure: entry.exposure ?? merged[idx].exposure };
                } else {
                    merged.push(entry);
                }
            }
            await updateConfig({
                reverseProxy: {
                    ...config.reverseProxy,
                    publicDomain: publicDomain || config.reverseProxy?.publicDomain,
                    hosts: merged,
                },
            });
            // Keep domain-reachability + dns-routing health checks in
            // sync with the newly persisted host list. Fire-and-forget:
            // failures are non-blocking and the next call (or boot-time
            // sync) catches up.
            try {
                const { syncDomainChecks } = await import('@/lib/health/domainChecks');
                const { syncDnsRoutingChecks } = await import('@/lib/health/dnsRoutingChecks');
                void syncDomainChecks();
                void syncDnsRoutingChecks();
            } catch { /* nice-to-have observability — never block deploy */ }
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
            // LAN-only hosts that got bound to the auto-managed access
            // list. Empty when no host had exposure='lan' or when the
            // access-list creation hiccupped (in which case those hosts
            // are still publicly reachable — the diagnose UI is the
            // recovery path).
            lanRestricted: results.filter(r => r.lanRestricted).map(r => r.domain),
            adminUrl: npm.apiUrl,
            node: npm.nodeName,
        });
    } catch (error) {
        logger.error('api:nginx:proxy-hosts', 'Failed to configure proxy hosts', error);
        return NextResponse.json({ error: 'Failed to configure proxy hosts' }, { status: 500 });
    }
}
