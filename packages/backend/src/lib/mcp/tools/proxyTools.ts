/**
 * Reverse-proxy MCP tools (#2384 extraction): reading the aggregated proxy
 * state plus the three route writers (config-only, full NPM host, removal).
 *
 * Note: writing to config records the desired route. Pushing to NPM (Nginx
 * Proxy Manager) needs NPM admin credentials, so the two tools that touch the
 * live host go through the app's own `/api/system/nginx/proxy-hosts` endpoint
 * over a loopback call rather than re-implementing the NPM client here.
 */
import { z } from 'zod';
import { getStoreSnapshot } from '@/lib/store/repository';
import { getConfig, updateConfig, type ProxyHostEntry } from '@/lib/config';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { AUTHELIA_FORWARD_AUTH_SENTINEL } from '@/lib/stackInstall/forwardAuth';
import { nodeParam, textResult, errorResult, type ToolRegistration } from './context';

/**
 * Loopback fetch to this process's own Next API, carrying the internal
 * API token so proxy.ts's CSRF/session gate accepts the state-changing
 * call (no cookie, no Origin). Same pattern as the install runner's
 * `apiFetch` (postInstallDispatcher.ts) — used by the MCP proxy/install
 * tools that reuse the install-runner HTTP wiring (#2140/#2141).
 */
function loopbackFetch(path: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}

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
      const qs = node ? `?node=${encodeURIComponent(node)}` : '';
      const res = await loopbackFetch(`/api/system/nginx/proxy-hosts${qs}`, { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) liveHosts = (data as { hosts?: unknown }).hosts ?? [];
      else liveError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    }
    return textResult({ proxyState, liveHosts, ...(liveError ? { liveStatusError: liveError } : {}) });
  });

  server.tool(
    'add_proxy_route',
    'Add or update a reverse-proxy route entry in ServiceBay config. Domain is the public hostname; forwardPort is the internal port. Updates `config.reverseProxy.hosts`. Pushing to NPM still requires the user to click "sync" in Settings.',
    {
      domain: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain').describe('Public domain, e.g. "vault.example.com"'),
      forwardPort: z.number().int().min(1).max(65535).describe('Internal port the upstream service listens on'),
      service: z.string().optional().describe('Logical service name (default: first label of domain)'),
    },
    async ({ domain, forwardPort, service }) => {
      const config = await getConfig();
      const hosts = [...(config.reverseProxy?.hosts ?? [])];
      const idx = hosts.findIndex(h => h.domain === domain);
      const entry: ProxyHostEntry = {
        domain,
        service: service ?? domain.split('.')[0],
        forwardPort,
        created: idx >= 0 ? hosts[idx].created : false,
        sslConfigured: idx >= 0 ? hosts[idx].sslConfigured : false,
        createdAt: idx >= 0 ? hosts[idx].createdAt : new Date().toISOString(),
      };
      if (idx >= 0) hosts[idx] = entry;
      else hosts.push(entry);
      await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts } });
      return textResult({
        action: idx >= 0 ? 'updated' : 'added',
        entry,
        note: 'Config updated. Push to NPM via Settings → Reverse Proxy → Sync.',
      });
    },
  );

  // #2140 — Create a COMPLETE NPM proxy host in one MCP call, reusing the
  // install-runner's proxy-host wiring (POST /api/system/nginx/proxy-hosts):
  // exposure tier (cert + LAN allow-list), Authelia forward-auth, optional
  // custom advanced_config / forwardHost / ssl, best-effort LE cert. Unlike
  // add_proxy_route (which only records a config entry for a later manual
  // sync), this pushes to NPM immediately and returns the per-host result
  // (created, certIssued/certError, lanRestricted). The forward-auth snippet
  // is expanded server-side by the route with the correct acme-bypass handling
  // per exposure (#2143 — no duplicate acme location on LE hosts).
  server.tool(
    'create_proxy_route',
    'Create a complete NPM reverse-proxy host in one call: pick an exposure tier (public|internal|lan), optionally gate it behind Authelia forward-auth SSO, and (for public/internal) request a Let\'s Encrypt cert — matching what a template install produces. Pushes to NPM immediately (unlike add_proxy_route, which only records a config entry). Returns the create + cert outcome per host; check get_proxy_routes for live nginx_online status afterward.',
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
      // Compose the advanced_config: forward-auth sentinel first (the route
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
        const res = await loopbackFetch('/api/system/nginx/proxy-hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hosts: [host], node }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
          return errorResult(`Failed to create proxy route for ${domain}: ${msg}`);
        }
        const d = data as { created?: string[]; failed?: { domain: string; error?: string }[]; certs?: { domain: string; issued: boolean; error?: string }[]; lanRestricted?: string[] };
        const failedHere = (d.failed ?? []).find(f => f.domain === domain);
        if (failedHere) {
          return errorResult(`NPM rejected the proxy host for ${domain}: ${failedHere.error ?? 'unknown error'}`);
        }
        return textResult({
          created: (d.created ?? []).includes(domain),
          domain,
          exposure,
          forwardAuth: !!forwardAuth,
          cert: (d.certs ?? []).find(c => c.domain === domain) ?? null,
          lanRestricted: (d.lanRestricted ?? []).includes(domain),
          note: 'Route pushed to NPM. Poll get_proxy_routes to confirm nginx_online=true (a bad conf reverts silently otherwise).',
        });
      } catch (e) {
        return errorResult(`Error creating proxy route: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // #2343 — remove_proxy_route is config-only by default, but with
  // `removeNpmHost:true` it also deletes the LIVE NPM host (symmetry with
  // create_proxy_route). It routes through the same DELETE
  // /api/system/nginx/proxy-hosts endpoint the diagnose `delete_route`
  // remediation and the uninstall capability use — that endpoint deletes the
  // NPM host AND drops it from config.reverseProxy.hosts in one step, so both
  // sides stay drift-free (no config-entry-gone-but-live-host-lingers). We do
  // NOT re-implement the NPM deletion here.
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
        return textResult({ action: 'removed', domain, npmHostRemoved: false });
      }
      // Live removal: reuse the shared DELETE endpoint (deletes the NPM host
      // AND drops it from config.reverseProxy.hosts — drift-free).
      try {
        const qs = new URLSearchParams({ domain });
        if (node) qs.set('node', node);
        const res = await loopbackFetch(`/api/system/nginx/proxy-hosts?${qs.toString()}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404 && (data as { reason?: string }).reason === 'not_found') {
          // NPM had no such host. Still reconcile config so we don't leave a
          // stale config entry behind (drift-free either way).
          const config = await getConfig();
          const hosts = config.reverseProxy?.hosts ?? [];
          const filtered = hosts.filter(h => h.domain !== domain);
          if (filtered.length !== hosts.length) {
            await updateConfig({ reverseProxy: { ...config.reverseProxy, hosts: filtered } });
          }
          return textResult({ action: 'removed', domain, npmHostRemoved: false, note: 'No live NPM host found for this domain; config entry cleared if present.' });
        }
        if (!res.ok) {
          const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
          return errorResult(`Failed to remove NPM host for ${domain}: ${msg}`);
        }
        return textResult({ action: 'removed', domain, npmHostRemoved: true, note: 'Live NPM host and config entry both removed. Confirm via get_proxy_routes (gone from liveHosts and routes).' });
      } catch (e) {
        return errorResult(`Error removing proxy route: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
