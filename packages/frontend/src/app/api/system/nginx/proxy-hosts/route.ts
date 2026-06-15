import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig, ProxyHostEntry } from '@/lib/config';
import { getNodeTwins, getNodeTwin } from '@/lib/store/repository';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import { agentManager } from '@/lib/agent/manager';
import { listNodes } from '@/lib/nodes';
import { AUTHELIA_LOCATION_HEADERS, sanitizeForwardAuthPort } from '@/lib/stackInstall/forwardAuth';
import { checkPublicARecord, missingARecordMessage } from '@/lib/reverseProxy/publicDnsCheck';
import {
    withLanDeniedPage,
    deployLanDeniedPage,
    withForwardAuthDeniedPage,
    deployForwardAuthDeniedPage,
} from '@/lib/reverseProxy/lanDeniedPage';
import { withProxyErrorPage, deployProxyErrorPages } from '@/lib/reverseProxy/proxyErrorPages';

export const dynamic = 'force-dynamic';

const DeleteQuery = z.object({
  domain: z.string().optional(),
  node: z.string().optional(),
});

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
        /**
         * #999 — Set to true for upstreams that reject requests whose
         * Host header doesn't match their bind address (uvicorn's
         * TrustedHost middleware is the canonical example — hermes
         * dashboard). When true, the post-create file-patcher inlines
         * NPM's proxy.conf inside the location / block AND appends a
         * `proxy_set_header Host <forwardHost>:<forwardPort>;`
         * directive so the upstream sees its own bind address. Default
         * (false / unset) keeps NPM's `Host $host` behaviour, which is
         * what 90% of upstreams want.
         */
        strictUpstreamHost?: boolean;
        /**
         * #1683 — Set to true for upstreams that enforce an anti-DNS-rebind
         * Host check and only accept a *local* Host (ollama). Like
         * strictUpstreamHost the patcher inlines NPM's proxy.conf and sends a
         * SINGLE Host header (replacing proxy.conf's `Host $host`, never
         * appending a second Host line), but the value is forced to
         * `127.0.0.1:<forwardPort>` so the upstream sees a loopback Host
         * regardless of the node's LAN IP.
         */
        localUpstreamHost?: boolean;
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
    const nodeNames = nodeHint ? [nodeHint] : Object.keys(getNodeTwins());
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
        const apiHost = nodeName === 'Local' ? '127.0.0.1' : getNodeIp(nodeName);

        // For NPM's proxy_pass → other services: always use the node's LAN IP
        const nodeIp = getNodeIp(nodeName);

        return {
            apiUrl: `http://${apiHost}:${adminPort}`,
            nodeName,
            nodeIp,
        };
    }
    return null;
}

function getNodeIp(nodeName: string): string {
    const twin = getNodeTwin(nodeName);
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

    // Stored credentials — set by Settings → Networking & Access → Reverse Proxy
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
/**
 * POST a new LAN-only access list to NPM. Returns the new list's id, or
 * null on any failure (logged). The list's rules are evaluated top-down
 * with first-match-wins, so the allow-LAN/allow-localhost/deny-all order
 * is load-bearing.
 */
async function createLanAccessList(baseUrl: string, token: string, cidr: string): Promise<number | null> {
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

async function ensureLanAccessList(baseUrl: string, token: string, nodeIp: string): Promise<number | null> {
    const cidr = lanCidrFromIp(nodeIp);
    if (!cidr) {
        logger.warn('ProxyHosts', `Could not derive LAN CIDR from node IP ${nodeIp}; skipping access-list setup.`);
        return null;
    }

    // Look for an existing list by name. expand=clients gives us the
    // rule list so we can detect drift and patch instead of duplicating.
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

    return createLanAccessList(baseUrl, token, cidr);
}

/**
 * Look up an existing NPM proxy host by domain. Returns the proxy
 * host object (with `id`) when found, `null` when not present. Used
 * by `createProxyHost` so a second create-attempt for the same
 * domain isn't reported as a failure when the host already exists
 * from a prior install / re-trigger of the provisioner.
 */
async function findProxyHostByDomain(baseUrl: string, token: string, domain: string): Promise<{ id: number; advanced_config?: string; forward_host?: string; forward_port?: number } | null> {
    try {
        const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts?expand=owner,access_list,certificate`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const list = (await res.json()) as Array<{ id: number; domain_names?: string[]; advanced_config?: string; forward_host?: string; forward_port?: number }>;
        const existing = list.find(h => Array.isArray(h.domain_names) && h.domain_names.includes(domain));
        return existing
            ? {
                id: existing.id,
                advanced_config: existing.advanced_config ?? '',
                forward_host: existing.forward_host,
                forward_port: existing.forward_port,
            }
            : null;
    } catch {
        return null;
    }
}

/**
 * #1178 — When a proxy host already exists for a domain but its
 * `forward_host` / `forward_port` no longer match what the installer
 * requested (e.g. \`hermes-webui\` replaces \`open-webui\` at
 * \`chat.<domain>\` — same URL, different upstream port), update the
 * existing host's target rather than leaving the stale upstream in
 * place. Returns true when an update was made; false when no change
 * was needed.
 *
 * Live finding 2026-05-27 on core@192.168.178.100: \`open-webui\` had
 * registered \`chat.dopp.cloud → 127.0.0.1:8080\`; \`hermes-webui\`'s
 * post-deploy ran the decommission flow but never reconciled the
 * proxy, so operators kept seeing the old Open WebUI on the chat
 * URL even after the migration completed.
 */
async function reconcileProxyHostUpstream(
    baseUrl: string,
    token: string,
    hostId: number,
    domain: string,
    expectedHost: string,
    expectedPort: number,
    currentHost: string | undefined,
    currentPort: number | undefined,
): Promise<boolean> {
    if (currentHost === expectedHost && currentPort === expectedPort) return false;
    try {
        const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts/${hostId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ forward_host: expectedHost, forward_port: expectedPort }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            logger.warn('ProxyHosts', `Failed to update forward target for ${domain} (NPM PUT returned ${res.status})`);
            return false;
        }
        logger.info('ProxyHosts', `Reconciled ${domain} upstream: ${currentHost ?? '?'}:${currentPort ?? '?'} → ${expectedHost}:${expectedPort}`);
        return true;
    } catch (e) {
        logger.warn('ProxyHosts', `Failed to update forward target for ${domain}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/**
 * Pure decision for `patchProxyHostAdvancedConfig`: given the live
 * config and the template-rendered config, decide whether (and what) to
 * PUT back to NPM. Exported so the SB-owned-vs-manual-edit policy can be
 * unit-tested without mocking NPM's HTTP API.
 *
 * The distinction this encodes:
 *
 * - A rendered config that contains `auth_request /authelia` is a
 *   **ServiceBay-OWNED** host — the whole `advanced_config` is template
 *   territory (forward-auth snippet + any appended extras the template
 *   ships via the `__authelia_forward_auth__\n<extras>` sentinel form,
 *   e.g. `proxy_buffering off` / `proxy_read_timeout 600s`). When the
 *   rendered value differs from live we land the rendered value verbatim
 *   — whether forward-auth is being ADDED for the first time (legacy
 *   #991) OR the extras changed on a host that already had forward-auth
 *   (#1862: the chat SSE directives were silently dropped because the
 *   old guard only fired when forward-auth was *missing*). The rendered
 *   config already carries the LAN explainer / proxy-error page wiring
 *   the POST loop injected, so adopting it wholesale is correct.
 *
 * - A rendered config WITHOUT forward-auth is NOT treated as owning the
 *   live config. We only ever **append** the LAN-only 403 explainer when
 *   the live host predates it (#1415) — genuine manual operator edits on
 *   such hosts are preserved (we never clobber).
 *
 * Returns `{ write, reason }` to PUT, or `{ skip }` to leave live alone.
 */
export function decideAdvancedConfigReconcile(
    existingAdvancedConfig: string,
    newAdvancedConfig: string,
): { write: string; reason: string } | { skip: true } {
    if (!newAdvancedConfig) return { skip: true };
    if (existingAdvancedConfig === newAdvancedConfig) return { skip: true };
    const hasForwardAuth = (s: string) => /auth_request\s+\/authelia/.test(s);
    // #1415 — backfill the LAN-only 403 explainer onto an existing host
    // whose config predates it (the marker is the idempotency key).
    const hasLanExplainer = (s: string) => s.includes('servicebay-lan-only-explainer');
    // #1862 — the rendered config carrying forward-auth marks this host as
    // ServiceBay-owned, so land it on ANY diff (not just when forward-auth
    // is newly added). This covers the appended-extras case where the host
    // already had forward-auth but the template's extra nginx directives
    // changed and were previously dropped.
    const ownedByTemplate = hasForwardAuth(newAdvancedConfig);
    const addsExplainer = hasLanExplainer(newAdvancedConfig) && !hasLanExplainer(existingAdvancedConfig);
    // Nothing to land → leave the existing config (and any manual edits) alone.
    if (!ownedByTemplate && !addsExplainer) return { skip: true };
    // SB-owned host: adopt the template's full rendered config (forward-auth
    // snippet + appended extras + the explainer/error-page wiring the POST
    // loop already folded into `newAdvancedConfig`). When the host is NOT
    // SB-owned and only the explainer is missing, append it to the EXISTING
    // config so manual operator edits are preserved.
    if (ownedByTemplate) {
        const addedForwardAuth = !hasForwardAuth(existingAdvancedConfig);
        return {
            write: newAdvancedConfig,
            reason: addedForwardAuth
                ? 'added Authelia forward-auth missing on the existing host'
                : 'reconciled template-owned advanced_config (forward-auth + appended extras) on the existing host',
        };
    }
    return { write: withLanDeniedPage(existingAdvancedConfig), reason: 'added LAN-only 403 explainer missing on the existing host' };
}

/**
 * #991 / #1862 — Reconcile an existing NPM proxy host's `advanced_config`
 * with what the template's `variables.json` currently declares. The
 * legacy "exists → return as-is" path leaves a stale config in place when
 * a template is updated post-install (e.g. file-share added Authelia
 * forward-auth, or the chat host's SSE directives changed). The
 * SB-owned-vs-manual-edit policy lives in `decideAdvancedConfigReconcile`
 * above (and is unit-tested there).
 *
 * Failures are logged but non-fatal — install proceeds with the stale
 * config in place, the diagnose probe surfaces the drift, operator can
 * retry from Settings → Self-Diagnose → Reprovision.
 */
export async function patchProxyHostAdvancedConfig(
    baseUrl: string,
    token: string,
    hostId: number,
    existingAdvancedConfig: string,
    newAdvancedConfig: string,
    domain: string,
): Promise<{ updated: boolean }> {
    const decision = decideAdvancedConfigReconcile(existingAdvancedConfig, newAdvancedConfig);
    if ('skip' in decision) return { updated: false };
    const configToWrite = decision.write;
    try {
        const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts/${hostId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ advanced_config: configToWrite }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            logger.warn('ProxyHosts', `Failed to reconcile advanced_config for ${domain} (NPM PUT returned ${res.status})`);
            return { updated: false };
        }
        logger.info('ProxyHosts', `Reconciled advanced_config for ${domain} (${decision.reason})`);
        return { updated: true };
    } catch (e) {
        logger.warn('ProxyHosts', `Failed to reconcile advanced_config for ${domain}: ${e instanceof Error ? e.message : String(e)}`);
        return { updated: false };
    }
}

/**
 * #999 — Inject location-level proxy_set_header directives into the
 * generated NPM proxy_host config file. nginx's inheritance rules drop
 * server-level `proxy_set_header` (where NPM's `advanced_config` ends
 * up) when the `location /` block has any of its own — and NPM's
 * bundled proxy.conf always sets `Host $host` plus X-Forwarded-*,
 * which means the Authelia headers from advanced_config never reach
 * the upstream.
 *
 * Live observation (logged in #991, #990): filebrowser saw empty
 * Remote-User → 500 "username is empty"; hermes' uvicorn TrustedHost
 * saw `Host: hermes.dopp.cloud` → 400 "Invalid Host header." The
 * same fix (Remote-* inside `location /`, + for hermes a Host
 * rewrite that wins over proxy.conf's `Host $host`) made the live box
 * fully green.
 *
 * Patches the .conf via `sudo write_file` (#1000) because NPM's
 * container writes the file as root from the host's perspective.
 * Idempotent: skips if Remote-User is already present, or if the
 * server-level advanced_config doesn't contain `auth_request`.
 */
/**
 * Pure transform: given a proxy_host conf body, return the patched body with
 * forward-auth Remote-* headers (and an optional Host override for strict-host
 * upstreams) injected into the `location /` block. Returns `{ skip }` with a
 * reason whenever there's nothing to do, keeping the async caller free of the
 * branchy string surgery — which is also why it's exported for unit tests.
 */
export function buildForwardAuthPatch(
    original: string,
    upstreamHostHeader: string | undefined,
): { content: string } | { skip: string } {
    // Skip if not a forward-auth proxy_host.
    if (!/auth_request\s+\/authelia/.test(original)) {
        return { skip: 'no forward-auth' };
    }
    // #1677 — Repair a malformed empty Authelia port (`127.0.0.1:/api/authz/`)
    // that NPM regenerated from a bad stored advanced_config BEFORE any
    // other skip/return path, so a host whose only defect is the empty
    // port still gets fixed (the auth-request upstream is otherwise
    // untouched by the Remote-*/Host surgery below). An empty port is an
    // nginx `[emerg]` that would crash the whole proxy on reload, so this
    // fix must land even when headers/Host are already present.
    const portFix = sanitizeForwardAuthPort(original);
    const content = portFix.content;
    // Skip if Remote-User is already inside the location / block.
    const locationMatch = content.match(/location\s+\/\s*\{[\s\S]*?\n\s*\}/);
    if (!locationMatch) {
        // A port-only repair with no location block still needs writing.
        return portFix.repaired ? { content } : { skip: 'no `location /` block' };
    }
    const locationBlock = locationMatch[0];
    const needsHeaders = !/proxy_set_header\s+Remote-User/.test(locationBlock);
    const needsHostRewrite = !!upstreamHostHeader && !locationBlock.includes(`proxy_set_header Host ${upstreamHostHeader}`);
    if (!needsHeaders && !needsHostRewrite) {
        return portFix.repaired ? { content } : { skip: 'already patched' };
    }
    let patchedLocation = locationBlock;
    if (needsHeaders) {
        // Inject before `include conf.d/include/proxy.conf;`. The
        // include is where NPM lays down Host $host; doing the
        // Remote-* set BEFORE the include keeps the standard
        // X-Forwarded-* chain intact and lets nginx's "all
        // proxy_set_header in this location" rule pick up our
        // additions.
        patchedLocation = patchedLocation.replace(
            /(\s+)(include conf\.d\/include\/proxy\.conf;)/,
            `$1${AUTHELIA_LOCATION_HEADERS}$1$2`,
        );
    }
    if (needsHostRewrite) {
        // For uvicorn-style strict-host upstreams (hermes), proxy.conf
        // sets `Host $host` which conflicts with our override. Strip
        // proxy.conf's Host line by inlining proxy.conf without it,
        // then add our Host directive at the end.
        const PROXY_CONF_INLINE = [
            '    add_header       X-Served-By $host;',
            '    proxy_set_header X-Forwarded-Scheme $x_forwarded_scheme;',
            '    proxy_set_header X-Forwarded-Proto  $x_forwarded_proto;',
            '    proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;',
            '    proxy_set_header X-Real-IP          $remote_addr;',
            '    proxy_pass       $forward_scheme://$server:$port$request_uri;',
        ].join('\n');
        patchedLocation = patchedLocation
            .replace(/(\s+)include conf\.d\/include\/proxy\.conf;/, `$1${PROXY_CONF_INLINE}\n    proxy_set_header Host ${upstreamHostHeader};`);
    }
    const newContent = content.replace(locationBlock, patchedLocation);
    if (newContent === original) {
        return { skip: 'no replacement needed' };
    }
    return { content: newContent };
}

async function patchProxyHostConfFile(
    hostId: number,
    domain: string,
    upstreamHostHeader: string | undefined,
    node: string | undefined,
): Promise<{ patched: boolean; reason?: string }> {
    const confPath = `/mnt/data/stacks/nginx-proxy-manager/data/nginx/proxy_host/${hostId}.conf`;
    try {
        const nodes = await listNodes();
        const nodeName = node ?? nodes[0]?.Name ?? 'Local';
        const agent = agentManager.getAgent(nodeName);
        const readRes = await agent.sendCommand('read_file', { path: confPath }) as { content?: string; error?: string };
        const content = readRes?.content;
        if (!content) {
            return { patched: false, reason: `could not read ${confPath}` };
        }
        const patch = buildForwardAuthPatch(content, upstreamHostHeader);
        if ('skip' in patch) {
            return { patched: false, reason: patch.skip };
        }
        const writeRes = await agent.sendCommand('write_file', { path: confPath, content: patch.content, sudo: true }) as { result?: string; error?: string };
        if (writeRes?.error) {
            logger.warn('ProxyHosts', `Failed to patch ${confPath} for ${domain}: ${writeRes.error}`);
            return { patched: false, reason: writeRes.error };
        }
        // #1677 defense-in-depth — validate the whole config with `nginx -t`
        // BEFORE reloading. A single malformed proxy_host (e.g. an empty
        // Authelia port) makes `nginx -s reload` fail and, on a reboot,
        // refuses to start nginx at all — taking down EVERY domain. If the
        // new config doesn't pass, quarantine just this host: restore its
        // previous .conf so the rest of the proxy keeps serving, and surface
        // the [emerg] reason instead of reloading a config that crashes.
        const testRes = await agent.sendCommand('exec', {
            command: 'podman exec nginx-nginx-proxy-manager nginx -t 2>&1',
        }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) as { output?: string; stdout?: string; result?: string; error?: string };
        const testOut = testRes?.output ?? testRes?.stdout ?? testRes?.result ?? '';
        const testFailed = /\[emerg\]|test failed|invalid port/i.test(testOut) || !!testRes?.error;
        if (testFailed) {
            // Roll the offending host back to its pre-patch conf so it can't
            // crash the proxy; the patch we just wrote never gets loaded.
            await agent.sendCommand('write_file', { path: confPath, content, sudo: true }).catch(() => {});
            const reason = `nginx -t rejected the patched config for ${domain}; quarantined (kept previous conf). ${testOut.split('\n').find(l => /\[emerg\]/i.test(l))?.trim() ?? testRes?.error ?? ''}`.trim();
            logger.warn('ProxyHosts', reason);
            return { patched: false, reason };
        }
        // Reload nginx to pick up the change (config validated above).
        await agent.sendCommand('exec', { command: 'podman exec nginx-nginx-proxy-manager nginx -s reload' }).catch(() => {});
        logger.info('ProxyHosts', `Patched ${domain} location / with forward-auth headers${upstreamHostHeader ? ` + Host=${upstreamHostHeader}` : ''}`);
        return { patched: true };
    } catch (e) {
        return { patched: false, reason: e instanceof Error ? e.message : String(e) };
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
        // #991 / #1862 — Reconcile advanced_config for a ServiceBay-owned
        // host (one whose rendered config carries forward-auth) when the
        // template's rendered value differs from live — whether forward-auth
        // is newly added or its appended extras (SSE/timeout directives)
        // changed. decideAdvancedConfigReconcile leaves genuine manual edits
        // on non-SB-owned hosts alone.
        await patchProxyHostAdvancedConfig(
            baseUrl,
            token,
            existing.id,
            existing.advanced_config ?? '',
            host.proxyConfig?.advanced_config ?? '',
            host.domain,
        );
        // #1178 — Reconcile forward target when a new template takes
        // over a domain that another template previously owned (e.g.
        // hermes-webui replacing open-webui at chat.<domain>). Without
        // this, the proxy keeps pointing at the dead service. The
        // caller has already defaulted `host.forwardHost` to the node
        // LAN IP before reaching here (see line 831).
        if (host.forwardHost) {
            await reconcileProxyHostUpstream(
                baseUrl,
                token,
                existing.id,
                host.domain,
                host.forwardHost,
                host.forwardPort,
                existing.forward_host,
                existing.forward_port,
            );
        }
        return { id: existing.id };
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

/**
 * Resolve the NPM certificate id to bind to a host: reuse a still-valid
 * LE cert when one already covers `domain` (#566 — avoids the LE "5
 * identical / week" rate limit on re-installs), otherwise ask NPM to
 * issue a fresh one. NPM blocks until the ACME exchange completes, so the
 * issue timeout is generous.
 *
 * Schema note: recent NPM (master) tightened the certificate `meta`
 * schema with `additionalProperties: false` and dropped both
 * `letsencrypt_email` and `letsencrypt_agree`. The ACME email now comes
 * from the owner user's account (NPM reads `user.email` on the
 * authenticated principal), set by our bootstrap PUT /api/users/1.
 * Sending the legacy fields makes NPM 400 "data/meta must NOT have
 * additional properties". Callers gate on a configured admin email before
 * reaching here, since NPM can't register with Let's Encrypt without one.
 */
async function acquireCertId(
    baseUrl: string,
    token: string,
    domain: string,
): Promise<{ certId: number; reused: boolean } | { error: string }> {
    const reusable = await findReusableCert(baseUrl, token, domain);
    if (reusable !== null) {
        logger.info('ProxyHosts', `Reusing existing NPM cert #${reusable} for ${domain} (avoids LE rate-limit churn on re-installs)`);
        return { certId: reusable, reused: true };
    }
    // #1680 — Before firing a fresh HTTP-01 request, confirm the domain has
    // a PUBLIC A record. LE validates against the internet-visible record,
    // but the box's own resolver (AdGuard `*.<domain>` wildcard) always
    // answers, masking a missing record — so a cert request just times out
    // and leaves a silently cert-less host. Query a public resolver and, if
    // there's no record, fail loudly with the exact "add A → <ip>" message
    // instead of burning an ACME attempt. An inconclusive check (every
    // resolver errored) does NOT block — we don't want a transient DNS
    // outage to stop a legitimate cert.
    const dns = await checkPublicARecord(domain);
    if (!dns.hasRecord && !dns.inconclusive) {
        return { error: missingARecordMessage(domain) };
    }
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
            return { error: `NPM /api/nginx/certificates returned HTTP ${res.status}: ${body.slice(0, 200) || 'no body'}` };
        }
        const data = await res.json() as { id?: number };
        if (typeof data.id !== 'number') {
            return { error: 'NPM accepted the cert request but returned no id.' };
        }
        return { certId: data.id, reused: false };
    } catch (e) {
        return { error: `Cert request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
}

async function requestPublicCert(
    baseUrl: string,
    token: string,
    proxyHostId: number,
    domain: string,
): Promise<{ ok: true; certId: number; reused?: boolean } | { ok: false; reason: string }> {
    // 1) Resolve the cert (reuse an existing one or issue a fresh one).
    const cert = await acquireCertId(baseUrl, token, domain);
    if ('error' in cert) return { ok: false, reason: cert.error };
    const { certId, reused } = cert;

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
    return { ok: true, certId, reused };
}

/**
 * POST: Create proxy hosts in NPM
 * Body: { hosts: [{ domain, forwardPort, forwardHost?, forwardScheme?, proxyConfig? }], node? }
 *
 * If forwardHost is not set, it defaults to the node's LAN IP.
 */
export const POST = withApiHandler({}, async ({ request }) => {
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

        // #1415 — Ship the branded "this host is LAN-only" 403 explainer into
        // NPM's data volume once per batch when any host binds the LAN access
        // list. The per-host `advanced_config` (below) wires `error_page 403`
        // → an internal SSI location that aliases this file, so a denied
        // off-LAN client sees a self-explaining page (with its own IP) instead
        // of the bare openresty 403. Best-effort: a write hiccup just leaves
        // the old bare 403 in place. Only attempt if the access list actually
        // bound — without it the deny rule (and thus the 403) never fires.
        if (lanAccessListId !== null) {
            await deployLanDeniedPage(node);
        }

        // #1583 — Ship the branded unknown-subdomain explainer + bare-proxy-error
        // page into NPM's data volume and wire the catch-all "dead host" server
        // at the explainer, so an unconfigured *.dopp.cloud host (typically a
        // typo) renders a self-explaining page instead of the raw openresty 401.
        // Unconditional (unlike the LAN-denied page): the default server fires
        // for ANY unknown host regardless of access lists. The per-host 401/502/504
        // error_page is wired below in the create loop. Best-effort — a write
        // hiccup just leaves the old bare openresty page in place.
        const errorPageDomain = publicDomain ?? config.reverseProxy?.publicDomain;
        await deployProxyErrorPages(errorPageDomain, node);

        const results: { domain: string; success: boolean; error?: string; certIssued?: boolean; certError?: string; lanRestricted?: boolean }[] = [];

        for (const host of hosts) {
            // Default forward host = node LAN IP (NPM is in a container,
            // 127.0.0.1 would only reach the NPM pod itself)
            if (!host.forwardHost) {
                host.forwardHost = npm.nodeIp;
            }
            const wantsLanList = host.exposure === 'lan' || host.exposure === 'internal';
            const accessListId = wantsLanList && lanAccessListId !== null ? lanAccessListId : 0;
            // #1415 — When this host is actually behind the LAN access list
            // (i.e. its deny-all rule will produce the 403), wire the branded
            // explainer into its `advanced_config`. Idempotent; preserves any
            // existing directives (forward-auth, timeouts, …). The access rule
            // itself is UNCHANGED — only the denied-response body differs.
            if (accessListId !== 0) {
                host.proxyConfig = {
                    ...host.proxyConfig,
                    advanced_config: withLanDeniedPage(host.proxyConfig?.advanced_config),
                };
            }
            // #1583 — Wire the branded bare-proxy-error page (401/502/503/504)
            // into every configured host. A 401 here means the Authelia login
            // redirect didn't fire; 502/504 means the upstream is down/starting.
            // Idempotent; preserves any existing directives (incl. the #1415
            // LAN-denied block, which owns 403 separately).
            host.proxyConfig = {
                ...host.proxyConfig,
                advanced_config: withProxyErrorPage(host.proxyConfig?.advanced_config),
            };
            let createdHost: { id?: number } | null = null;
            // #999 — When the host needs forward-auth or a strict upstream
            // Host header, the generated .conf must be patched so the
            // directives land in the LOCATION block where nginx honours
            // them (the server-level advanced_config alone is silently
            // dropped by NPM's location-level proxy.conf include). We
            // compute the need once here and re-apply it after cert-bind
            // (see #1623): requestPublicCert's certificate_id PUT makes NPM
            // regenerate the .conf, wiping this location patch. The patch is
            // idempotent (buildForwardAuthPatch no-ops when already present).
            const wantsForwardAuth = /auth_request\s+\/authelia|__authelia_forward_auth__/.test(host.proxyConfig?.advanced_config ?? '');
            const wantsStrictHost = !!host.proxyConfig?.strictUpstreamHost;
            // #1683 — ollama's anti-DNS-rebind guard only accepts a LOCAL
            // Host (127.0.0.1:<port>); proxy.conf's `Host $host` =
            // ollama.dopp.cloud → 403, and naively appending a second
            // `proxy_set_header Host` sends two Host lines → 400. The
            // patcher replaces (not appends) the Host with this loopback
            // value, regardless of the node's LAN forward_host.
            const wantsLocalHost = !!host.proxyConfig?.localUpstreamHost;
            const wantsConfPatch = wantsForwardAuth || wantsStrictHost || wantsLocalHost;
            const upstreamHostHeader = wantsLocalHost
                ? `127.0.0.1:${host.forwardPort}`
                : wantsStrictHost
                ? `${host.forwardHost ?? '127.0.0.1'}:${host.forwardPort}`
                : undefined;
            // #1684 — A forward-auth host's 403 is an Authelia AUTHORIZATION
            // deny (signed-in but wrong group), NOT the LAN-only deny. Wire
            // its `error_page 403` to a branded explainer that names the
            // required group (derived from this domain's access_control rule)
            // and echoes the signed-in $user/$groups via SSI — instead of the
            // misleading LAN-only page. A forward-auth host is not LAN-bound
            // (it serves https with a cert), so the two `error_page 403`
            // owners never collide. Best-effort; preserves existing directives.
            if (wantsForwardAuth && accessListId === 0) {
                host.proxyConfig = {
                    ...host.proxyConfig,
                    advanced_config: withForwardAuthDeniedPage(host.proxyConfig?.advanced_config, host.domain),
                };
                await deployForwardAuthDeniedPage(host.domain, errorPageDomain, node);
            }
            try {
                createdHost = await createProxyHost(npm.apiUrl, token, host, accessListId);
                results.push({ domain: host.domain, success: true, lanRestricted: accessListId !== 0 });
                logger.info('ProxyHosts', `Created proxy host: ${host.domain} → ${host.forwardHost}:${host.forwardPort} (exposure=${host.exposure ?? 'lan'}${accessListId !== 0 ? ', LAN-only via access list' : ''})`);
                if (wantsConfPatch && typeof createdHost?.id === 'number') {
                    await patchProxyHostConfFile(createdHost.id, host.domain, upstreamHostHeader, node);
                }
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
                    const reason = 'No ACME registration email configured (set reverseProxy.npm.email in Settings → Networking & Access); skipped cert request.';
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
                    );
                    if (certResult.ok) {
                        results[results.length - 1].certIssued = true;
                        if (certResult.reused) {
                            logger.info('ProxyHosts', `Reused existing LE cert ${certResult.certId} for ${host.domain} (re-install survived #534 cert-archive — no ACME call needed)`);
                        } else {
                            logger.info('ProxyHosts', `Issued + bound LE cert ${certResult.certId} for ${host.domain}`);
                        }
                        // #1623 — Binding the cert (certificate_id PUT) makes
                        // NPM regenerate the .conf, discarding the #999
                        // location-level forward-auth/Host patch applied above.
                        // Re-apply it so the Remote-* identity headers and the
                        // strict-host Host rewrite survive cert-bind. Idempotent.
                        if (wantsConfPatch && typeof createdHost?.id === 'number') {
                            await patchProxyHostConfFile(createdHost.id, host.domain, upstreamHostHeader, node);
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
});


/**
 * DELETE /api/system/nginx/proxy-hosts?domain=<fqdn>[&node=<n>]
 *
 * Removes a proxy host by domain. Called by the NPM capability handler
 * (#630) on `feature.uninstalled`. Idempotent: a 404 means the host
 * was already gone (or never existed), which uninstall paths treat as
 * success.
 *
 * Mirrors POST's NPM-discovery + token-acquisition pattern. Doesn't
 * touch the cert — orphaned LE certs aren't free to dispose of (the
 * shared cert bundle may still be in use by another host), and the
 * cert_request_failure diagnose probe surfaces stale certs separately.
 */
export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteQuery>>(
  { query: DeleteQuery },
  async ({ query }) => {
    try {
        const domain = query.domain;
        const node = query.node;
        if (!domain) {
            return NextResponse.json({ error: 'domain query parameter is required' }, { status: 400 });
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
                error: 'Could not authenticate with NPM. Please provide your NPM admin credentials.',
                adminUrl: npm.apiUrl,
                needsCredentials: true,
            }, { status: 401 });
        }

        const existing = await findProxyHostByDomain(npm.apiUrl, token, domain);
        if (!existing) {
            return NextResponse.json({ removed: false, reason: 'not_found' }, { status: 404 });
        }

        const res = await fetch(`${npm.apiUrl}/api/nginx/proxy-hosts/${existing.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger.warn('ProxyHosts', `NPM DELETE for ${domain} (id=${existing.id}) returned ${res.status}: ${body}`);
            return NextResponse.json({
                error: `NPM API returned ${res.status}`,
            }, { status: 502 });
        }

        // Mirror POST's persist step: drop the host from
        // `config.reverseProxy.hosts` so the route inventory stays in
        // sync. Best-effort — a missing config write doesn't undo the
        // NPM-side delete.
        try {
            const cfg = await getConfig();
            const hosts = cfg.reverseProxy?.hosts ?? [];
            const next = hosts.filter(h => h.domain !== domain);
            if (next.length !== hosts.length) {
                await updateConfig({
                    reverseProxy: { ...(cfg.reverseProxy || {}), hosts: next },
                });
            }
        } catch (e) {
            logger.warn('ProxyHosts', `Failed to drop ${domain} from config.reverseProxy.hosts: ${e}`);
        }

        logger.info('ProxyHosts', `Removed proxy host: ${domain} (id=${existing.id})`);
        return NextResponse.json({ removed: true, domain, id: existing.id });
    } catch (error) {
        logger.error('api:nginx:proxy-hosts:delete', 'Failed to delete proxy host', error);
        return NextResponse.json({ error: 'Failed to delete proxy host' }, { status: 500 });
    }
});
