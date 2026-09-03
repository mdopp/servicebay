/**
 * Proxy-host provisioning — the kernel behind `POST/DELETE/GET
 * /api/system/nginx/proxy-hosts` and the MCP `create_proxy_route` /
 * `remove_proxy_route` / `get_proxy_routes` tools (#2731).
 *
 * Until #2731 all of this lived in the route file and the MCP tools called
 * the route over a loopback HTTP hop. Now the route is a thin handler and
 * the tools call these functions directly; NPM itself is only ever spoken
 * to through `lib/npm/*`.
 *
 * Three entry points, one per verb:
 *   - `provisionProxyHosts`  — create-or-reconcile a batch of hosts, bind
 *     certs, persist `config.reverseProxy.hosts`, sync the health checks;
 *   - `removeProxyHost`      — delete one host by domain, drop it from config,
 *     retire its domain check (#2654);
 *   - `listLiveProxyHosts`   — NPM's live per-host status (#2140).
 *
 * Each returns a discriminated result; mapping it to an HTTP status or an
 * MCP error is the caller's job.
 */
import { agentManager } from '../agent/manager';
import { getConfig, updateConfig, type ProxyHostEntry } from '../config';
import { syncDnsRoutingChecks } from '../health/dnsRoutingChecks';
import { syncDomainChecks } from '../health/domainChecks';
import { logger } from '../logger';
import { listNodes } from '../nodes';
import { ensureLanAccessList } from '../npm/accessLists';
import { bindCertToProxyHost, listCertificates, requestLetsEncryptCert } from '../npm/certs';
import { findNpmAdmin, getNpmToken, type NpmAdmin } from '../npm/client';
import {
    checkNginxOnline,
    createProxyHost,
    deleteProxyHost,
    findProxyHostByDomain,
    listProxyHosts,
    updateProxyHost,
    type NpmProxyHost,
} from '../npm/proxyHosts';
import { DEFAULT_AUTHELIA_PORT, renderForwardAuthAdvancedConfig } from '../stackInstall/forwardAuth';
import {
    deployForwardAuthDeniedPage,
    deployLanDeniedPage,
    withForwardAuthDeniedPage,
    withLanDeniedPage,
} from './lanDeniedPage';
import { deployProxyErrorPages, withProxyErrorPage } from './proxyErrorPages';
import {
    buildForwardAuthPatch,
    decideAdvancedConfigReconcile,
    decideUpstreamReconcile,
    type ProxyHostRequest,
} from './proxyHostPolicy';
import { checkPublicARecord, missingARecordMessage } from './publicDnsCheck';

export type { ProxyHostRequest } from './proxyHostPolicy';

// NPM discovery is `findNpmAdmin({ requireActive: true })` for every verb
// here: they all mutate NPM's tables (or read them to answer for the running
// instance), and without a node hint the iteration must land on the node
// whose NPM is actually up, not the first stale twin entry. `nodeIp` is what
// a proxy host's forward_host must carry: from inside NPM's pod 127.0.0.1 is
// NPM itself.
const NPM_LOOKUP = { requireActive: true } as const;

/** The three outcomes every verb shares before it gets to its own work. */
type NpmSessionFailure =
    | { kind: 'npm-not-found' }
    | { kind: 'auth-failed'; adminUrl: string };

interface NpmSession {
    npm: NpmAdmin;
    token: string;
}

async function openNpmSession(
    node: string | undefined,
    credentials?: { email: string; password: string },
): Promise<({ kind: 'ok' } & NpmSession) | NpmSessionFailure> {
    const npm = await findNpmAdmin({ node, ...NPM_LOOKUP });
    if (!npm) return { kind: 'npm-not-found' };
    const token = await getNpmToken(npm.apiUrl, credentials);
    if (!token) return { kind: 'auth-failed', adminUrl: npm.apiUrl };
    return { kind: 'ok', npm, token };
}

// ─── Reconcile an existing host ─────────────────────────────────────────

/**
 * #1178 / #2364 — When a proxy host already exists for a domain but its
 * `forward_host` / `forward_port` no longer match what the installer
 * requested — a new template taking over a domain (`hermes-webui` replaces
 * `open-webui` at `chat.<domain>`, #1178) OR a port publish moving from the
 * LAN IP to loopback (radicale's `loopbackOnly: true`, #2364/#2357) — update
 * the existing host's target rather than leaving the stale upstream in
 * place. Returns true when an update was made. Only the forward target is
 * PUT, so exposure / auth / cert are preserved (see
 * `decideUpstreamReconcile`).
 */
async function reconcileProxyHostUpstream(
    apiUrl: string,
    token: string,
    hostId: number,
    domain: string,
    expectedHost: string,
    expectedPort: number,
    currentHost: string | undefined,
    currentPort: number | undefined,
): Promise<boolean> {
    if (!decideUpstreamReconcile(expectedHost, expectedPort, currentHost, currentPort).changed) return false;
    try {
        const r = await updateProxyHost(apiUrl, token, hostId, { forward_host: expectedHost, forward_port: expectedPort });
        if (!r.ok) {
            logger.warn('ProxyHosts', `Failed to update forward target for ${domain} (NPM PUT returned ${r.status})`);
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
 * #991 / #1862 — Reconcile an existing NPM proxy host's `advanced_config`
 * with what the template's `variables.json` currently declares. The policy
 * (SB-owned vs manual edit) is `decideAdvancedConfigReconcile`. Failures
 * are logged but non-fatal — install proceeds with the stale config in
 * place, the diagnose probe surfaces the drift, operator can retry from
 * Settings → Self-Diagnose → Reprovision.
 */
export async function patchProxyHostAdvancedConfig(
    apiUrl: string,
    token: string,
    hostId: number,
    existingAdvancedConfig: string,
    newAdvancedConfig: string,
    domain: string,
): Promise<{ updated: boolean }> {
    const decision = decideAdvancedConfigReconcile(existingAdvancedConfig, newAdvancedConfig);
    if ('skip' in decision) return { updated: false };
    try {
        const r = await updateProxyHost(apiUrl, token, hostId, { advanced_config: decision.write });
        if (!r.ok) {
            logger.warn('ProxyHosts', `Failed to reconcile advanced_config for ${domain} (NPM PUT returned ${r.status})`);
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
 * #999 — Patch the generated proxy_host .conf on the node so the
 * forward-auth Remote-* headers (and a strict-host Host override) land in
 * the `location /` block. Patches via `sudo write_file` (#1000) because
 * NPM's container writes the file as root from the host's perspective.
 * Idempotent (`buildForwardAuthPatch` no-ops when already present).
 */
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
            // #2156 — a failing rollback write leaves the crashing patch on
            // disk, so log the command error instead of swallowing it: the
            // operator (and box-verify) needs to know the quarantine itself
            // didn't take.
            await agent.sendCommand('write_file', { path: confPath, content, sudo: true }).catch((e: unknown) => {
                logger.error('ProxyHosts', `Rollback write of ${confPath} for ${domain} FAILED — the rejected patch may still be on disk: ${e instanceof Error ? e.message : String(e)}`);
            });
            const reason = `nginx -t rejected the patched config for ${domain}; quarantined (kept previous conf). ${testOut.split('\n').find(l => /\[emerg\]/i.test(l))?.trim() ?? testRes?.error ?? ''}`.trim();
            logger.warn('ProxyHosts', reason);
            return { patched: false, reason };
        }
        // Reload nginx to pick up the change (config validated above).
        // #2156 — a `nginx -s reload` failure here leaves stale routing with
        // zero breadcrumb; log the command error so a silently-dead reload is
        // visible in the install log / journal instead of vanishing.
        await agent.sendCommand('exec', { command: 'podman exec nginx-nginx-proxy-manager nginx -s reload' }).catch((e: unknown) => {
            logger.warn('ProxyHosts', `nginx -s reload after patching ${domain} FAILED — routing may be stale: ${e instanceof Error ? e.message : String(e)}`);
        });
        logger.info('ProxyHosts', `Patched ${domain} location / with forward-auth headers${upstreamHostHeader ? ` + Host=${upstreamHostHeader}` : ''}`);
        return { patched: true };
    } catch (e) {
        return { patched: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

// ─── Create ─────────────────────────────────────────────────────────────

/** `findProxyHostByDomain` with the expansion this module has always
 *  requested and `advanced_config` normalised to a string. */
async function findExistingHost(apiUrl: string, token: string, domain: string): Promise<NpmProxyHost | null> {
    const existing = await findProxyHostByDomain(apiUrl, token, domain, { expand: ['owner', 'access_list', 'certificate'] });
    return existing ? { ...existing, advanced_config: existing.advanced_config ?? '' } : null;
}

/**
 * Create a proxy host in NPM, or reconcile the one that already serves
 * the domain.
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
async function createOrReconcileProxyHost(
    apiUrl: string,
    token: string,
    host: ProxyHostRequest,
    accessListId: number = 0,
): Promise<{ id?: number }> {
    const existing = await findExistingHost(apiUrl, token, host.domain);
    if (existing) {
        // #991 / #1862 — Reconcile advanced_config for a ServiceBay-owned
        // host when the template's rendered value differs from live.
        // decideAdvancedConfigReconcile leaves genuine manual edits on
        // non-SB-owned hosts alone.
        await patchProxyHostAdvancedConfig(
            apiUrl,
            token,
            existing.id,
            existing.advanced_config ?? '',
            host.proxyConfig?.advanced_config ?? '',
            host.domain,
        );
        // #1178 — Reconcile forward target when a new template takes over a
        // domain that another template previously owned. The caller has
        // already defaulted `host.forwardHost` to the node LAN IP.
        if (host.forwardHost) {
            await reconcileProxyHostUpstream(
                apiUrl,
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
    const r = await createProxyHost(apiUrl, token, {
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
    });

    if (!r.ok) {
        // Belt-and-braces: NPM can race with us between the pre-check
        // and the POST (two concurrent provisioners), so a 400 here
        // might still mean "exists" rather than an actual rejection.
        // Look it up once more before reporting the failure.
        if (r.status === 400) {
            const racedExisting = await findExistingHost(apiUrl, token, host.domain);
            if (racedExisting) return racedExisting;
        }
        let message: string | undefined;
        try {
            message = (JSON.parse(r.body) as { message?: string }).message;
        } catch {
            // not JSON — fall through to the status line
        }
        throw new Error(message || `NPM API returned ${r.status}`);
    }
    return r.data;
}

// ─── Certificates ───────────────────────────────────────────────────────

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
 * "request a fresh one" path. A cert that expires in less than
 * `EXPIRY_MIN_DAYS` is treated as no-match so NPM's nightly renew
 * doesn't race the install.
 */
const EXPIRY_MIN_DAYS = 14;
async function findReusableCert(apiUrl: string, token: string, domain: string): Promise<number | null> {
    try {
        const r = await listCertificates(apiUrl, token, { expand: ['owner'] });
        if (!r.ok || !Array.isArray(r.data)) return null;
        const cutoff = Date.now() + EXPIRY_MIN_DAYS * 24 * 60 * 60 * 1000;
        // Newest-first so multiple matches pick the freshest cert (NPM
        // doesn't dedupe by domain on its side; an operator who hit
        // the rate limit and ran an old install too could have two
        // certificate rows for the same domain).
        const candidates = r.data
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
 * LE cert when one already covers `domain` (#566), otherwise ask NPM to
 * issue a fresh one. Callers gate on a configured admin email before
 * reaching here, since NPM can't register with Let's Encrypt without one.
 */
async function acquireCertId(
    apiUrl: string,
    token: string,
    domain: string,
): Promise<{ certId: number; reused: boolean } | { error: string }> {
    const reusable = await findReusableCert(apiUrl, token, domain);
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
        const r = await requestLetsEncryptCert(apiUrl, token, domain);
        if (!r.ok) {
            return { error: `NPM certificate request returned HTTP ${r.status}: ${r.body.slice(0, 200) || 'no body'}` };
        }
        if (typeof r.data.id !== 'number') {
            return { error: 'NPM accepted the cert request but returned no id.' };
        }
        return { certId: r.data.id, reused: false };
    } catch (e) {
        return { error: `Cert request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/**
 * Request (or reuse) a Let's Encrypt cert and bind it to the proxy host.
 * Best-effort: returns `{ ok: false, reason }` on every kind of failure so
 * the wizard log shows "cert pending" rather than blowing up the install —
 * the cert_request_failure diagnose probe is the recovery path.
 */
async function requestPublicCert(
    apiUrl: string,
    token: string,
    proxyHostId: number,
    domain: string,
): Promise<{ ok: true; certId: number; reused?: boolean } | { ok: false; reason: string }> {
    const cert = await acquireCertId(apiUrl, token, domain);
    if ('error' in cert) return { ok: false, reason: cert.error };
    const { certId, reused } = cert;
    // Bind the cert so HTTPS becomes the canonical URL. Without this step
    // the cert exists in NPM but the proxy host still serves on port 80.
    try {
        const r = await bindCertToProxyHost(apiUrl, token, proxyHostId, certId);
        if (!r.ok) {
            // Cert is issued; binding failed. Operator can do this manually
            // in NPM admin → Hosts → Edit. Surface the partial success.
            return { ok: false, reason: `Cert ${certId} issued but binding to proxy host ${proxyHostId} failed (HTTP ${r.status}: ${r.body.slice(0, 160)}). Open NPM admin → Hosts → Edit → SSL to bind it.` };
        }
    } catch (e) {
        return { ok: false, reason: `Cert ${certId} issued but the bind PUT failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, certId, reused };
}

// ─── Provision a batch ──────────────────────────────────────────────────

export interface ProvisionProxyHostsInput {
    hosts: ProxyHostRequest[];
    node?: string;
    publicDomain?: string;
    npmCredentials?: { email: string; password: string };
}

/** Per-host outcome, as the wizard / MCP tool consume it. */
interface ProvisionSummary {
    success: boolean;
    created: string[];
    failed: { domain: string; error?: string }[];
    /** Present only for hosts that requested a cert (public/internal). */
    certs: { domain: string; issued: boolean; error?: string }[];
    /** Hosts bound to the auto-managed LAN access list. */
    lanRestricted: string[];
    /** #2156 — hosts NPM created (200) but nginx refused to load. Also in `failed`. */
    nginxOffline: { domain: string; nginx_err?: string }[];
    adminUrl: string;
    node: string;
}

export type ProvisionProxyHostsResult = NpmSessionFailure | ({ kind: 'ok' } & ProvisionSummary);

interface HostOutcome {
    domain: string;
    success: boolean;
    error?: string;
    certIssued?: boolean;
    certError?: string;
    lanRestricted?: boolean;
    nginxOffline?: boolean;
    nginxErr?: string;
}

interface BatchContext extends NpmSession {
    node?: string;
    leEmail?: string;
    errorPageDomain?: string;
    lanAccessListId: number | null;
    authPort: string;
}

/** Fold the batch-level wiring into one host's request: forward-auth
 *  rendering, default upstream, LAN/proxy-error/forward-auth-denied pages. */
async function prepareHost(input: ProxyHostRequest, ctx: BatchContext): Promise<{
    host: ProxyHostRequest;
    accessListId: number;
    wantsConfPatch: boolean;
    upstreamHostHeader: string | undefined;
}> {
    const host: ProxyHostRequest = { ...input };
    if (host.proxyConfig?.advanced_config) {
        // The `__authelia_forward_auth__` sentinel is normally expanded by the
        // STACK INSTALLER right before Mustache renders. A DIRECT call (a
        // manual create, or a diagnose/heal that re-asserts a host) has no
        // installer step — so expand the sentinel AND substitute the Authelia
        // port here, exactly like the installer, or the literal sentinel lands
        // in the .conf → `nginx: [emerg] unknown directive`.
        // #2143 — public/internal hosts get an LE cert; NPM injects its own
        // acme-challenge location, so omit ours to avoid the `[emerg]
        // duplicate location` crash that reverts the conf.
        const omitAcmeBypass = host.exposure === 'public' || host.exposure === 'internal';
        // #2205 — a websocket host gets a server-level `proxy_http_version
        // 1.1;` from NPM; strip any copy in advanced_config so we never emit
        // the duplicate directive that invalidates the whole vhost.
        host.proxyConfig = {
            ...host.proxyConfig,
            advanced_config: renderForwardAuthAdvancedConfig(host.proxyConfig.advanced_config, ctx.authPort, { omitAcmeBypass, authSkipPaths: host.proxyConfig.authSkipPaths, websocket: host.proxyConfig.allow_websocket_upgrade }),
        };
    }
    // Default forward host = node LAN IP (NPM is in a container,
    // 127.0.0.1 would only reach the NPM pod itself)
    if (!host.forwardHost) host.forwardHost = ctx.npm.nodeIp;
    const wantsLanList = host.exposure === 'lan' || host.exposure === 'internal';
    const accessListId = wantsLanList && ctx.lanAccessListId !== null ? ctx.lanAccessListId : 0;
    // #1415 — When this host is actually behind the LAN access list, wire
    // the branded explainer into its `advanced_config`. Idempotent;
    // preserves any existing directives. The access rule itself is
    // UNCHANGED — only the denied-response body differs.
    if (accessListId !== 0) {
        host.proxyConfig = { ...host.proxyConfig, advanced_config: withLanDeniedPage(host.proxyConfig?.advanced_config) };
    }
    // #1583 — Wire the branded bare-proxy-error page (401/502/503/504) into
    // every configured host. Idempotent; preserves existing directives.
    host.proxyConfig = { ...host.proxyConfig, advanced_config: withProxyErrorPage(host.proxyConfig?.advanced_config) };
    // #999 — When the host needs forward-auth or a strict upstream Host
    // header, the generated .conf must be patched so the directives land in
    // the LOCATION block where nginx honours them. Computed once here and
    // re-applied after cert-bind (#1623), since the certificate_id PUT makes
    // NPM regenerate the .conf.
    const wantsForwardAuth = /auth_request\s+\/authelia|__authelia_forward_auth__/.test(host.proxyConfig?.advanced_config ?? '');
    const wantsStrictHost = !!host.proxyConfig?.strictUpstreamHost;
    // #1683 — ollama's anti-DNS-rebind guard only accepts a LOCAL Host;
    // the patcher replaces (not appends) the Host with this loopback value.
    const wantsLocalHost = !!host.proxyConfig?.localUpstreamHost;
    const upstreamHostHeader = wantsLocalHost
        ? `127.0.0.1:${host.forwardPort}`
        : wantsStrictHost
        ? `${host.forwardHost ?? '127.0.0.1'}:${host.forwardPort}`
        : undefined;
    // #1684 — A forward-auth host's 403 is an Authelia AUTHORIZATION deny
    // (signed-in but wrong group), NOT the LAN-only deny. Wire its
    // `error_page 403` to a branded explainer naming the required group. A
    // forward-auth host is not LAN-bound, so the two owners never collide.
    if (wantsForwardAuth && accessListId === 0) {
        host.proxyConfig = { ...host.proxyConfig, advanced_config: withForwardAuthDeniedPage(host.proxyConfig?.advanced_config, host.domain) };
        await deployForwardAuthDeniedPage(host.domain, ctx.errorPageDomain, ctx.node);
    }
    return { host, accessListId, wantsConfPatch: wantsForwardAuth || wantsStrictHost || wantsLocalHost, upstreamHostHeader };
}

/** Auto-cert for public AND internal hosts. Best-effort: install continues
 *  regardless of ACME outcome — `cert_request_failure` is the recovery path.
 *  Internal hosts get a real cert too so Authelia forward-auth works. */
async function provisionCert(
    ctx: BatchContext,
    host: ProxyHostRequest,
    hostId: number | undefined,
    outcome: HostOutcome,
    reapplyConfPatch: () => Promise<unknown>,
): Promise<void> {
    if (!ctx.leEmail) {
        const reason = 'No ACME registration email configured (set reverseProxy.npm.email in Settings → Networking & Access); skipped cert request.';
        outcome.certError = reason;
        logger.warn('ProxyHosts', `Skip cert for ${host.domain}: ${reason}`);
        return;
    }
    if (typeof hostId !== 'number') {
        outcome.certError = 'NPM did not return a proxy host id; cannot bind a cert without it.';
        return;
    }
    const certResult = await requestPublicCert(ctx.npm.apiUrl, ctx.token, hostId, host.domain);
    if (!certResult.ok) {
        outcome.certError = certResult.reason;
        logger.warn('ProxyHosts', `Cert request failed for ${host.domain}: ${certResult.reason}`);
        return;
    }
    outcome.certIssued = true;
    if (certResult.reused) {
        logger.info('ProxyHosts', `Reused existing LE cert ${certResult.certId} for ${host.domain} (re-install survived issue 534 cert-archive — no ACME call needed)`);
    } else {
        logger.info('ProxyHosts', `Issued + bound LE cert ${certResult.certId} for ${host.domain}`);
    }
    // #1623 — Binding the cert (certificate_id PUT) makes NPM regenerate
    // the .conf, discarding the #999 location-level patch applied above.
    // Re-apply it so the Remote-* headers and Host rewrite survive.
    await reapplyConfPatch();
}

async function provisionOneHost(input: ProxyHostRequest, ctx: BatchContext): Promise<HostOutcome> {
    const { host, accessListId, wantsConfPatch, upstreamHostHeader } = await prepareHost(input, ctx);
    const outcome: HostOutcome = { domain: host.domain, success: true, lanRestricted: accessListId !== 0 };
    let createdHost: { id?: number } | null = null;
    const reapplyConfPatch = async () => {
        if (wantsConfPatch && typeof createdHost?.id === 'number') {
            await patchProxyHostConfFile(createdHost.id, host.domain, upstreamHostHeader, ctx.node);
        }
    };
    try {
        createdHost = await createOrReconcileProxyHost(ctx.npm.apiUrl, ctx.token, host, accessListId);
        logger.info('ProxyHosts', `Created proxy host: ${host.domain} → ${host.forwardHost}:${host.forwardPort} (exposure=${host.exposure ?? 'lan'}${accessListId !== 0 ? ', LAN-only via access list' : ''})`);
        await reapplyConfPatch();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('ProxyHosts', `Failed to create proxy host ${host.domain}: ${msg}`);
        return { domain: host.domain, success: false, error: msg };
    }

    if (host.exposure === 'public' || host.exposure === 'internal') {
        await provisionCert(ctx, host, createdHost?.id, outcome, reapplyConfPatch);
    }

    // #2156 — NPM's create/cert-bind/patch all returned "ok", but the route
    // only actually routes if nginx loaded the conf. Read the live
    // meta.nginx_online now (after cert-bind + any re-patch have settled)
    // and flag the step so a dead route isn't reported green.
    if (typeof createdHost?.id === 'number') {
        const onlineStatus = await checkNginxOnline(ctx.npm.apiUrl, ctx.token, createdHost.id);
        if (!onlineStatus.online) {
            outcome.nginxOffline = true;
            outcome.nginxErr = onlineStatus.err;
            outcome.success = false;
            outcome.error = outcome.error ?? `nginx refused the conf (nginx_online=false): ${onlineStatus.err}`;
            logger.error('ProxyHosts', `Route ${host.domain} created in NPM but nginx_online=false — traffic will 000/502. nginx_err: ${onlineStatus.err}`);
        }
    }
    return outcome;
}

/** Persist the batch into `config.reverseProxy.hosts` (merge by domain)
 *  and re-sync the domain-reachability + dns-routing health checks.
 *  Best-effort: a failed write never undoes what NPM already has. */
async function persistProvisionedHosts(
    hosts: ProxyHostRequest[],
    results: HostOutcome[],
    publicDomain: string | undefined,
): Promise<void> {
    try {
        const config = await getConfig();
        const existingHosts = config.reverseProxy?.hosts || [];
        const newEntries: ProxyHostEntry[] = hosts.map(h => ({
            domain: h.domain,
            service: h.service || h.domain.split('.')[0],
            forwardPort: h.forwardPort,
            created: results.find(r => r.domain === h.domain)?.success ?? false,
            createdAt: new Date().toISOString(),
            // Persist exposure so downstream consumers (domain health
            // checks, diagnose probes, letsdebug filter) can tell `lan`
            // from `public` without re-deriving it from the domain string.
            exposure: h.exposure,
        }));
        // Merge: update existing entries by domain, append new ones.
        // Preserve the previous `exposure` when the incoming entry doesn't
        // carry one (older clients).
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
        // Fire-and-forget: failures are non-blocking and the next call (or
        // boot-time sync) catches up.
        try {
            void syncDomainChecks();
            void syncDnsRoutingChecks();
        } catch { /* nice-to-have observability — never block deploy */ }
    } catch (e) {
        logger.warn('ProxyHosts', `Failed to persist proxy host config: ${e}`);
    }
}

/**
 * Create (or reconcile) every host in the batch. If `forwardHost` is not
 * set it defaults to the node's LAN IP.
 */
export async function provisionProxyHosts(input: ProvisionProxyHostsInput): Promise<ProvisionProxyHostsResult> {
    const { hosts, node, publicDomain, npmCredentials } = input;
    const session = await openNpmSession(node, npmCredentials);
    if (session.kind !== 'ok') return session;
    const { npm, token } = session;

    const config = await getConfig();
    // ACME registration email — needed when any host has a public/internal
    // exposure. The wizard hoists operatorEmail into the NPM admin email.
    const leEmail = config.reverseProxy?.npm?.email;

    // Auto-create the "ServiceBay LAN only" access list once if any host
    // wants it (at most two NPM calls per batch instead of N). `null`
    // falls back to the previous open behaviour for that subset of hosts
    // so the install doesn't fail just because the access-list creation
    // hiccupped — the diagnose UI is the recovery path. `lan` AND
    // `internal` both bind the list; `internal` additionally requests a
    // public LE cert (the ACME challenge location bypasses the allowlist
    // by design inside NPM).
    const needsLanList = hosts.some(h => h.exposure === 'lan' || h.exposure === 'internal');
    const lanAccessListId = needsLanList ? await ensureLanAccessList(npm.apiUrl, token, npm.nodeIp) : null;

    // #1415 — Ship the branded "this host is LAN-only" 403 explainer into
    // NPM's data volume once per batch when any host binds the LAN access
    // list. Best-effort; only attempted if the list actually bound.
    if (lanAccessListId !== null) await deployLanDeniedPage(node);

    // #1583 — Ship the branded unknown-subdomain explainer + bare-proxy-error
    // page and wire the catch-all "dead host" server at the explainer.
    // Unconditional: the default server fires for ANY unknown host.
    const errorPageDomain = publicDomain ?? config.reverseProxy?.publicDomain;
    await deployProxyErrorPages(errorPageDomain, node);

    const ctx: BatchContext = {
        npm,
        token,
        node,
        leEmail,
        errorPageDomain,
        lanAccessListId,
        authPort: config.templateSettings?.AUTHELIA_PORT ?? DEFAULT_AUTHELIA_PORT,
    };
    const results: HostOutcome[] = [];
    for (const host of hosts) {
        results.push(await provisionOneHost(host, ctx));
    }

    await persistProvisionedHosts(hosts, results, publicDomain);

    const failed = results.filter(r => !r.success);
    return {
        kind: 'ok',
        success: failed.length === 0,
        created: results.filter(r => r.success).map(r => r.domain),
        failed: failed.map(r => ({ domain: r.domain, error: r.error })),
        certs: results
            .filter(r => r.certIssued || r.certError)
            .map(r => ({ domain: r.domain, issued: r.certIssued === true, error: r.certError })),
        lanRestricted: results.filter(r => r.lanRestricted).map(r => r.domain),
        nginxOffline: results.filter(r => r.nginxOffline).map(r => ({ domain: r.domain, nginx_err: r.nginxErr })),
        adminUrl: npm.apiUrl,
        node: npm.nodeName,
    };
}

// ─── Remove ─────────────────────────────────────────────────────────────

export type RemoveProxyHostResult =
    | NpmSessionFailure
    | { kind: 'not-found' }
    | { kind: 'npm-error'; status: number }
    | { kind: 'removed'; domain: string; id: number };

/**
 * Remove a proxy host by domain. Idempotent: `not-found` means the host
 * was already gone (or never existed), which uninstall paths treat as
 * success. Doesn't touch the cert — orphaned LE certs aren't free to
 * dispose of (the shared cert bundle may still be in use by another
 * host); the `cert_expiry` probe surfaces orphans separately (#2594).
 *
 * This is the one path every live-host removal takes (MCP
 * `remove_proxy_route(removeNpmHost)`, the diagnose `delete_route`
 * remediation, uninstall), so it also drops the config entry and retires
 * the domain check (#2654).
 */
export async function removeProxyHost(domain: string, node?: string): Promise<RemoveProxyHostResult> {
    const session = await openNpmSession(node);
    if (session.kind !== 'ok') return session;
    const { npm, token } = session;

    const existing = await findExistingHost(npm.apiUrl, token, domain);
    if (!existing) return { kind: 'not-found' };

    const r = await deleteProxyHost(npm.apiUrl, token, existing.id);
    if (!r.ok) {
        logger.warn('ProxyHosts', `NPM DELETE for ${domain} (id=${existing.id}) returned ${r.status}: ${r.body}`);
        return { kind: 'npm-error', status: r.status };
    }

    // Mirror the create path's persist step: drop the host from
    // `config.reverseProxy.hosts` so the route inventory stays in sync.
    // Best-effort — a missing config write doesn't undo the NPM-side delete.
    try {
        const cfg = await getConfig();
        const hosts = cfg.reverseProxy?.hosts ?? [];
        const next = hosts.filter(h => h.domain !== domain);
        if (next.length !== hosts.length) {
            await updateConfig({ reverseProxy: { ...(cfg.reverseProxy || {}), hosts: next } });
        }
    } catch (e) {
        logger.warn('ProxyHosts', `Failed to drop ${domain} from config.reverseProxy.hosts: ${e}`);
    }

    // #2654 — retire the domain check with the route instead of leaving it
    // for up to 60s until the timer catches it. `removedDomains` is
    // required: the polled route snapshot still carries this host, so a
    // plain sync would rebuild the check it just removed.
    try {
        await syncDomainChecks({ removedDomains: [domain] });
    } catch (e) {
        logger.warn('ProxyHosts', `Domain-check reconcile after removing ${domain} failed: ${e}`);
    }

    logger.info('ProxyHosts', `Removed proxy host: ${domain} (id=${existing.id})`);
    return { kind: 'removed', domain, id: existing.id };
}

// ─── Live status ────────────────────────────────────────────────────────

interface LiveProxyHost {
    id: number;
    domain: string;
    forwardHost?: string;
    forwardPort?: number;
    enabled: boolean;
    certBound: boolean;
    nginx_online: boolean | null;
    nginx_err: string | null;
}

export type ListLiveProxyHostsResult =
    | NpmSessionFailure
    | { kind: 'npm-error'; status: number }
    | { kind: 'ok'; node: string; hosts: LiveProxyHost[] };

/**
 * #2140 — NPM's LIVE per-host status, so a broken conf is visible without
 * reading NPM's sqlite by hand: `enabled` plus `meta.nginx_online` /
 * `meta.nginx_err`, which NPM sets after every `nginx -t`/reload.
 */
export async function listLiveProxyHosts(node?: string): Promise<ListLiveProxyHostsResult> {
    const session = await openNpmSession(node);
    if (session.kind !== 'ok') return session;
    const { npm, token } = session;
    const r = await listProxyHosts(npm.apiUrl, token, { expand: ['certificate'] });
    if (!r.ok) return { kind: 'npm-error', status: r.status };
    const hosts = (Array.isArray(r.data) ? r.data : []).map(h => ({
        id: h.id,
        domain: h.domain_names?.[0] ?? '',
        forwardHost: h.forward_host,
        forwardPort: h.forward_port,
        enabled: h.enabled === true || h.enabled === 1,
        certBound: typeof h.certificate_id === 'number' && h.certificate_id > 0,
        nginx_online: h.meta?.nginx_online ?? null,
        nginx_err: h.meta?.nginx_err ?? null,
    }));
    return { kind: 'ok', node: npm.nodeName, hosts };
}
