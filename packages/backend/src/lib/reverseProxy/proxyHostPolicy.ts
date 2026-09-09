/**
 * Pure decisions behind proxy-host provisioning (#2731 — extracted from
 * `app/api/system/nginx/proxy-hosts/route.ts`). Nothing here touches NPM,
 * the agent or config; each function is a string/record transform the
 * provisioning module applies and the unit tests exercise directly.
 */
import type { ProxyExposure } from '../config';
import { AUTHELIA_LOCATION_HEADERS, sanitizeForwardAuthPort } from '../stackInstall/forwardAuth';
import { withLanDeniedPage } from './lanDeniedPage';

/** One host as the wizard / install runner / MCP tool asks for it. */
export interface ProxyHostRequest {
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
    exposure?: ProxyExposure;
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
         * Host check and only accept a *local* Host (llama). Like
         * strictUpstreamHost the patcher inlines NPM's proxy.conf and sends a
         * SINGLE Host header (replacing proxy.conf's `Host $host`, never
         * appending a second Host line), but the value is forced to
         * `127.0.0.1:<forwardPort>` so the upstream sees a loopback Host
         * regardless of the node's LAN IP.
         */
        localUpstreamHost?: boolean;
        /**
         * #2210 — Path prefixes that skip forward-auth (emit `auth_request
         * off` locations that still proxy upstream) on a `forwardAuth` host,
         * e.g. `/.well-known/` (TWA assetlinks, ACME) or `/static/` (PWA
         * assets). Only meaningful with the forward-auth `advanced_config`.
         */
        authSkipPaths?: string[];
    };
}

/**
 * Pure decision for `reconcileProxyHostUpstream`: does the existing NPM
 * host's forward target already match what the installer wants, or must it
 * be re-pointed?
 *
 * Two callers rely on it:
 *   - #1178 — a new template takes over a domain (hermes-webui → open-webui
 *     at chat.<domain>): the port changes.
 *   - #2364 — a template's port publish moves from the LAN IP to loopback
 *     (radicale's `loopbackOnly: true`, completing #2357): the host changes
 *     from 192.168.178.100 → 127.0.0.1 on the SAME port. Without this, a
 *     redeploy of an EXISTING radicale left caldav.<domain> forwarding to
 *     the now-closed LAN address → 502.
 *
 * The reconcile PUT sends ONLY `forward_host`/`forward_port`, so it NEVER
 * touches exposure (access_list), auth (advanced_config / forward-auth) or
 * the bound cert (certificate_id) — the security posture is preserved. The
 * decision is idempotent: when live already equals expected it returns
 * `false` (no PUT), so re-running on an already-loopback host is a no-op.
 */
export function decideUpstreamReconcile(
    expectedHost: string,
    expectedPort: number,
    currentHost: string | undefined,
    currentPort: number | undefined,
): { changed: false } | { changed: true; from: string; to: string } {
    if (currentHost === expectedHost && currentPort === expectedPort) {
        return { changed: false };
    }
    return {
        changed: true,
        from: `${currentHost ?? '?'}:${currentPort ?? '?'}`,
        to: `${expectedHost}:${expectedPort}`,
    };
}

/**
 * Pure decision for `patchProxyHostAdvancedConfig`: given the live
 * config and the template-rendered config, decide whether (and what) to
 * PUT back to NPM.
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
 * #999 — Pure transform: given a proxy_host conf body, return the patched
 * body with forward-auth Remote-* headers (and an optional Host override
 * for strict-host upstreams) injected into the `location /` block.
 *
 * nginx's inheritance rules drop server-level `proxy_set_header` (where
 * NPM's `advanced_config` ends up) when the `location /` block has any of
 * its own — and NPM's bundled proxy.conf always sets `Host $host` plus
 * X-Forwarded-*, which means the Authelia headers from advanced_config
 * never reach the upstream. Live observation (#991, #990): filebrowser saw
 * empty Remote-User → 500 "username is empty"; hermes' uvicorn TrustedHost
 * saw `Host: hermes.dopp.cloud` → 400 "Invalid Host header."
 *
 * Returns `{ skip }` with a reason whenever there's nothing to do.
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

// ─── Exposure → NPM access list ─────────────────────────────────────────

/**
 * #2933 — the conservative resolution of an ABSENT exposure. A request that
 * carries no exposure is missing information, and missing information is
 * never permission: it resolves to the most restrictive tier, never to
 * `public`. `ProxyHostEntry.exposure` (config.ts) has documented this as the
 * rule all along; before #2933 the provisioning code read `undefined` as
 * "no allow-list" — i.e. open — which is the exact opposite.
 */
const DEFAULT_PROXY_EXPOSURE: ProxyExposure = 'lan';

/**
 * Which tiers must be bound to NPM's "ServiceBay LAN only" IP access list.
 *
 * Exhaustive over {@link PROXY_EXPOSURES} by TYPE (a new tier fails `tsc`)
 * and by TEST (`exposureReconcile.test.ts` iterates the contract). Do not
 * replace this with an `=== 'lan' || === 'internal'` expression: the point
 * of the table is that a new tier cannot slip through unanswered.
 */
const EXPOSURE_REQUIRES_LAN_ACCESS_LIST: Record<ProxyExposure, boolean> = {
    // Reachable from the internet on purpose: no IP gate.
    public: false,
    // LE cert so forward-auth works, but every non-ACME path is IP-gated.
    internal: true,
    // Plain HTTP, LAN only.
    lan: true,
};

/** Resolve an absent exposure to `DEFAULT_PROXY_EXPOSURE` (`lan`). */
export function normalizeExposure(exposure: ProxyExposure | undefined): ProxyExposure {
    return exposure ?? DEFAULT_PROXY_EXPOSURE;
}

/**
 * Does this exposure require the LAN access list? Throws on a value that is
 * not in the contract — a route we cannot classify must fail loudly rather
 * than fall through to "no access list", which publishes it wide open.
 */
export function requiresLanAccessList(exposure: ProxyExposure | undefined): boolean {
    const tier = normalizeExposure(exposure);
    const required = EXPOSURE_REQUIRES_LAN_ACCESS_LIST[tier];
    if (typeof required !== 'boolean') {
        throw new Error(`Unknown proxy exposure "${tier}" — refusing to provision a host whose access rule is undefined (it would be published open).`);
    }
    return required;
}

/**
 * The `access_list_id` NPM must end up holding for this exposure, given the
 * batch's LAN access-list id (`null` = NPM could not give us one).
 *
 * `{ ok: false }` is the loud failure the caller must surface: the host WANTS
 * an IP gate and there is no list to bind, so provisioning it would publish
 * it open while every report said "restricted". The old code silently used
 * `0` (open) here.
 */
export function decideAccessListId(
    exposure: ProxyExposure | undefined,
    lanAccessListId: number | null,
): { ok: true; accessListId: number } | { ok: false; reason: string } {
    if (!requiresLanAccessList(exposure)) return { ok: true, accessListId: 0 };
    if (lanAccessListId === null || lanAccessListId === 0) {
        return {
            ok: false,
            reason: `exposure "${normalizeExposure(exposure)}" requires NPM's LAN-only access list and none is available — refusing to publish the host without its IP gate`,
        };
    }
    return { ok: true, accessListId: lanAccessListId };
}

/**
 * Pure decision for the access-list reconcile on an EXISTING host: does
 * NPM's live `access_list_id` already match what the exposure demands?
 *
 * An absent `access_list_id` on the live row means NPM has no gate on it
 * (`0`), so it is compared as `0` — never as "unknown, leave alone".
 */
export function decideAccessListReconcile(
    expectedAccessListId: number,
    currentAccessListId: number | undefined,
): { changed: false } | { changed: true; from: number; to: number } {
    const current = currentAccessListId ?? 0;
    if (current === expectedAccessListId) return { changed: false };
    return { changed: true, from: current, to: expectedAccessListId };
}
