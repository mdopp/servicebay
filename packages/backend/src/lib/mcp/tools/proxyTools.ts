/**
 * Reverse-proxy MCP tools (#2384 extraction): reading the aggregated proxy
 * state plus the two route writers (full NPM host, removal).
 *
 * There is exactly ONE way to create a route here (#2726): `create_proxy_route`,
 * which pushes the host to NPM. The older `add_proxy_route` only wrote
 * `config.reverseProxy.hosts` and asked the operator to click Sync afterwards —
 * i.e. it manufactured the config≠NPM drift that `danglingProxy` /
 * `nginxOnlineFailed` report as a fault. It was a second, strictly weaker kernel
 * path, not an alias, so it is gone.
 *
 * The two tools that touch the live host call the same kernel the
 * `/api/system/nginx/proxy-hosts` route is a thin handler over
 * (`@/lib/reverseProxy/proxyHostProvisioning`, #2731) — no loopback HTTP hop,
 * no second NPM client. NPM itself is only ever spoken to through `@/lib/npm/*`.
 */
import { z } from 'zod';
import { getStoreSnapshot } from '@/lib/store/repository';
import { getConfig, updateConfig } from '@/lib/config';
import { AUTHELIA_FORWARD_AUTH_SENTINEL } from '@/lib/stackInstall/forwardAuth';
// #2654 — a route mutation reconciles the auto-managed `domain:<host>` checks
// immediately instead of leaving them to the 60s timer, so `get_health_checks`
// reflects the change the caller just made. `create_proxy_route` needs no call
// here: `provisionProxyHosts` already reconciles (and `removeProxyHost` does
// too, for the live-removal branch below).
import { syncDomainChecks } from '@/lib/health/domainChecks';
import { listLiveProxyHosts, provisionProxyHosts, removeProxyHost } from '@/lib/reverseProxy/proxyHostProvisioning';
import { nodeParam, textResult, errorResult, type ToolRegistration } from './context';

const NPM_NOT_FOUND = 'Nginx Proxy Manager not found or not running';
const NPM_AUTH_FAILED = 'Could not authenticate with NPM. Please provide your NPM admin credentials.';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerProxyTools({ server }: ToolRegistration) {
  // --- Get Proxy Routes ---
  // #2140 — Returns the aggregated proxy state AND, best-effort, NPM's LIVE
  // per-host status (enabled + nginx_online/nginx_err from NPM's DB). A host
  // whose conf nginx reverted shows nginx_online=false + the [emerg] reason,
  // so a broken route is visible from the MCP instead of only via NPM's sqlite.
  server.tool('get_proxy_routes', 'Get reverse proxy routes configuration, including each NPM host\'s live nginx status (nginx_online / nginx_err) when reachable — a broken conf shows nginx_online=false with the error.', { node: nodeParam }, async ({ node }) => {
    const proxyState = getStoreSnapshot().proxyState;
    let liveHosts: unknown = null;
    let liveError: string | undefined;
    try {
      const live = await listLiveProxyHosts(node);
      if (live.kind === 'ok') liveHosts = live.hosts;
      else if (live.kind === 'npm-not-found') liveError = NPM_NOT_FOUND;
      else if (live.kind === 'auth-failed') liveError = 'Could not authenticate with NPM.';
      else liveError = `NPM API returned ${live.status}`;
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    }
    return textResult({ proxyState, liveHosts, ...(liveError ? { liveStatusError: liveError } : {}) });
  });

  // #2140 — Create a COMPLETE NPM proxy host in one MCP call, reusing the
  // install-runner's proxy-host wiring (`provisionProxyHosts`):
  // exposure tier (cert + LAN allow-list), Authelia forward-auth, optional
  // custom advanced_config / forwardHost / ssl, best-effort LE cert. This is
  // the ONLY route-creating tool (#2726 retired the config-only
  // `add_proxy_route`): it pushes to NPM immediately and returns the per-host
  // result (created, certIssued/certError, lanRestricted). The forward-auth
  // snippet is expanded by the kernel with the correct acme-bypass handling
  // per exposure (#2143 — no duplicate acme location on LE hosts).
  server.tool(
    'create_proxy_route',
    'Create a reverse-proxy route — this is the ONE tool for it, and it replaces the removed `add_proxy_route` (which only recorded a config entry and left NPM out of sync). Creates a complete NPM reverse-proxy host in one call: pick an exposure tier (public|internal|lan), optionally gate it behind Authelia forward-auth SSO, and (for public/internal) request a Let\'s Encrypt cert — matching what a template install produces. Pushes to NPM immediately. Returns the create + cert outcome per host; check get_proxy_routes for live nginx_online status afterward.',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Full public hostname, e.g. "tor.dopp.cloud".'),
      forwardPort: z.number().int().min(1).max(65535).describe('Internal port the upstream service listens on.'),
      forwardHost: z.string().optional().describe('Upstream host/IP (default: the node\'s LAN IP — correct for services on the box).'),
      exposure: z.enum(['public', 'internal', 'lan']).optional().default('public').describe('public = LE cert + open; internal = LE cert + LAN-only allow-list; lan = no cert, LAN-only (forward-auth does NOT work on lan — Authelia needs https). Default: public.'),
      forwardAuth: z.boolean().optional().default(false).describe('Gate the route behind Authelia forward-auth SSO. Requires exposure public|internal (needs https). Expands the same nginx snippet a template install uses so Remote-User reaches the upstream.'),
      sslForced: z.boolean().optional().describe('Force HTTPS redirect (default true for public/internal once a cert binds).'),
      websocket: z.boolean().optional().describe('Enable WebSocket upgrade on the host.'),
      advancedConfig: z.string().optional().describe('Custom nginx directives to inject into the server block (appended after any forward-auth snippet).'),
      authSkipPaths: z.array(z.string().startsWith('/')).optional().describe('#2210 — path prefixes that skip forward-auth while the rest of the host stays gated, e.g. ["/.well-known/", "/static/"]. Each becomes an `auth_request off` location that still proxies upstream (TWA assetlinks, ACME, PWA assets). Only meaningful with forwardAuth=true.'),
      service: z.string().optional().describe('Logical service name (default: first label of the domain).'),
      node: nodeParam,
    },
    async ({ domain, forwardPort, forwardHost, exposure, forwardAuth, sslForced, websocket, advancedConfig, authSkipPaths, service, node }) => {
      if (forwardAuth && exposure === 'lan') {
        return errorResult('forwardAuth requires exposure "public" or "internal": Authelia forward-auth needs an https (cert-bound) host, and a "lan" host serves plain HTTP. Use exposure "internal" for a LAN-only SSO-gated service.');
      }
      // Compose the advanced_config: forward-auth sentinel first (the kernel
      // expands + port-substitutes it with the correct acme-bypass for the
      // exposure, #2143), then any custom directives the caller supplied.
      let composedAdvanced: string | undefined;
      if (forwardAuth) {
        composedAdvanced = advancedConfig
          ? `${AUTHELIA_FORWARD_AUTH_SENTINEL}\n${advancedConfig}`
          : AUTHELIA_FORWARD_AUTH_SENTINEL;
      } else if (advancedConfig) {
        composedAdvanced = advancedConfig;
      }
      const host = {
        domain,
        forwardPort,
        ...(forwardHost ? { forwardHost } : {}),
        service: service ?? domain.split('.')[0],
        exposure,
        proxyConfig: {
          ...(websocket !== undefined ? { allow_websocket_upgrade: websocket } : {}),
          ...(sslForced !== undefined ? { ssl_forced: sslForced } : {}),
          ...(composedAdvanced ? { advanced_config: composedAdvanced } : {}),
          ...(authSkipPaths?.length ? { authSkipPaths } : {}),
        },
      };
      try {
        const d = await provisionProxyHosts({ hosts: [host], node });
        if (d.kind === 'npm-not-found') return errorResult(`Failed to create proxy route for ${domain}: ${NPM_NOT_FOUND}`);
        if (d.kind === 'auth-failed') return errorResult(`Failed to create proxy route for ${domain}: ${NPM_AUTH_FAILED}`);
        const failedHere = d.failed.find(f => f.domain === domain);
        if (failedHere) {
          return errorResult(`NPM rejected the proxy host for ${domain}: ${failedHere.error ?? 'unknown error'}`);
        }
        return textResult({
          created: d.created.includes(domain),
          domain,
          exposure,
          forwardAuth: !!forwardAuth,
          cert: d.certs.find(c => c.domain === domain) ?? null,
          lanRestricted: d.lanRestricted.includes(domain),
          note: 'Route pushed to NPM. Poll get_proxy_routes to confirm nginx_online=true (a bad conf reverts silently otherwise).',
        });
      } catch (e) {
        return errorResult(`Error creating proxy route: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // #2343 — remove_proxy_route is config-only by default, but with
  // `removeNpmHost:true` it also deletes the LIVE NPM host (symmetry with
  // create_proxy_route). It routes through the same `removeProxyHost` kernel
  // the DELETE /api/system/nginx/proxy-hosts route, the diagnose `delete_route`
  // remediation and the uninstall capability use — it deletes the NPM host AND
  // drops it from config.reverseProxy.hosts in one step, so both sides stay
  // drift-free (no config-entry-gone-but-live-host-lingers). We do NOT
  // re-implement the NPM deletion here.
  server.tool(
    'remove_proxy_route',
    'Remove a reverse-proxy route. By default (removeNpmHost=false) this only drops the ServiceBay config entry and does NOT touch NPM. Set removeNpmHost=true to also delete the LIVE Nginx Proxy Manager host — this is the dedicated, destroy-scoped way to clean up a dangling route (one whose forward target has no backing service) end-to-end, so both the config entry AND the live host go away together (no config↔NPM drift). Read get_proxy_routes / run diagnose first to confirm the route is genuinely dangling before removing it — the live-host deletion is permanent.',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Public domain to remove'),
      removeNpmHost: z.boolean().optional().default(false).describe('When true, also delete the live NPM proxy host (not just the config entry). Uses the same server path as the diagnose "Delete route" remediation, removing the host from NPM and dropping it from config together. Default false (config-only, backward-compatible).'),
      node: nodeParam,
    },
    async ({ domain, removeNpmHost, node }) => {
      if (!removeNpmHost) {
        // Config-only (backward-compatible): drop the entry, leave NPM alone.
        const config = await getConfig();
        const hosts = config.reverseProxy?.hosts ?? [];
        const filtered = hosts.filter(h => h.domain !== domain);
        if (filtered.length === hosts.length) {
          return errorResult(`No proxy route found for domain "${domain}"`);
        }
        await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts: filtered } });
        // Config-only removal: the LIVE NPM host still exists, so the domain
        // check legitimately stays — but it must now be rebuilt from the route
        // instead of the (deleted) config entry, which is a different scheme /
        // upstream port. No `removedDomains`: nothing was actually removed.
        await syncDomainChecks();
        return textResult({ action: 'removed', domain, npmHostRemoved: false });
      }
      // Live removal: reuse the shared kernel (deletes the NPM host AND drops
      // it from config.reverseProxy.hosts — drift-free).
      try {
        const result = await removeProxyHost(domain, node);
        if (result.kind === 'not-found') {
          // NPM had no such host. Still reconcile config so we don't leave a
          // stale config entry behind (drift-free either way).
          const config = await getConfig();
          const hosts = config.reverseProxy?.hosts ?? [];
          const filtered = hosts.filter(h => h.domain !== domain);
          if (filtered.length !== hosts.length) {
            await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts: filtered } });
          }
          // NPM has no such host and config no longer claims it — the kernel
          // bailed before its own reconcile, so retire the check here.
          await syncDomainChecks({ removedDomains: [domain] });
          return textResult({ action: 'removed', domain, npmHostRemoved: false, note: 'No live NPM host found for this domain; config entry cleared if present.' });
        }
        if (result.kind === 'npm-not-found') return errorResult(`Failed to remove NPM host for ${domain}: ${NPM_NOT_FOUND}`);
        if (result.kind === 'auth-failed') return errorResult(`Failed to remove NPM host for ${domain}: ${NPM_AUTH_FAILED}`);
        if (result.kind === 'npm-error') return errorResult(`Failed to remove NPM host for ${domain}: NPM API returned ${result.status}`);
        return textResult({ action: 'removed', domain, npmHostRemoved: true, note: 'Live NPM host and config entry both removed. Confirm via get_proxy_routes (gone from liveHosts and routes).' });
      } catch (e) {
        return errorResult(`Error removing proxy route: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
