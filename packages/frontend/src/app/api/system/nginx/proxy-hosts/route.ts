import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import {
    listLiveProxyHosts,
    provisionProxyHosts,
    removeProxyHost,
    type ProxyHostRequest,
} from '@/lib/reverseProxy/proxyHostProvisioning';

/**
 * HTTP surface over the proxy-host kernel (#2731). Everything that talks
 * to NPM — discovery, auth, create/reconcile, certs, config persistence,
 * health-check sync — lives in `@/lib/reverseProxy/proxyHostProvisioning`
 * and `@/lib/npm/*`; this file only maps bodies/queries to those calls and
 * their results to HTTP statuses. The MCP `create_proxy_route` /
 * `remove_proxy_route` / `get_proxy_routes` tools call the same kernel
 * directly, so a behaviour change belongs there, not here.
 */
export const dynamic = 'force-dynamic';

const NPM_NOT_FOUND = { error: 'Nginx Proxy Manager not found or not running' };

function npmAuthFailed(adminUrl: string, message = 'Could not authenticate with NPM. Please provide your NPM admin credentials.') {
    return NextResponse.json({ error: message, adminUrl, needsCredentials: true }, { status: 401 });
}

/**
 * POST: Create proxy hosts in NPM
 * Body: { hosts: [{ domain, forwardPort, forwardHost?, forwardScheme?, proxyConfig? }], node?, publicDomain?, npmCredentials? }
 *
 * If forwardHost is not set, it defaults to the node's LAN IP.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async ({ request }) => {
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

        const result = await provisionProxyHosts({ hosts, node, publicDomain, npmCredentials });
        if (result.kind === 'npm-not-found') return NextResponse.json(NPM_NOT_FOUND, { status: 404 });
        if (result.kind === 'auth-failed') return npmAuthFailed(result.adminUrl);

        const { kind: _kind, ...summary } = result;
        // `summary.certs` is present only for hosts that requested a cert
        // (public/internal); `nginxOffline` (#2156) also appear in `failed[]`
        // and carry the [emerg] reason so the wizard can name the nginx error.
        return NextResponse.json(summary);
    } catch (error) {
        logger.error('api:nginx:proxy-hosts', 'Failed to configure proxy hosts', error);
        return NextResponse.json({ error: 'Failed to configure proxy hosts' }, { status: 500 });
    }
});

const DeleteQuery = z.object({
    domain: z.string().optional(),
    node: z.string().optional(),
});

/**
 * DELETE /api/system/nginx/proxy-hosts?domain=<fqdn>[&node=<n>]
 *
 * Removes a proxy host by domain. Called by the NPM capability handler
 * (#630) on `feature.uninstalled`. Idempotent: a 404 means the host
 * was already gone (or never existed), which uninstall paths treat as
 * success.
 */
export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteQuery>>(
  // #2142 — accept a scoped `sb_` bearer token (destroy scope) so token-driven
  // flows can remove a route symmetrically with create (POST=mutate). Removing
  // an NPM proxy host is a state-destroying op → `destroy`, matching the MCP
  // `remove_proxy_route` tier. Without this the DELETE was cookie-only (a
  // MUTATING verb with no tokenScope → requireSession rejects the Bearer and
  // 401s), so an agent could create a route with a token but not delete it.
  { query: DeleteQuery, tokenScope: 'destroy' },
  async ({ query }) => {
    try {
        const { domain, node } = query;
        if (!domain) {
            return NextResponse.json({ error: 'domain query parameter is required' }, { status: 400 });
        }
        const result = await removeProxyHost(domain, node);
        switch (result.kind) {
            case 'npm-not-found':
                return NextResponse.json(NPM_NOT_FOUND, { status: 404 });
            case 'auth-failed':
                return npmAuthFailed(result.adminUrl);
            case 'not-found':
                return NextResponse.json({ removed: false, reason: 'not_found' }, { status: 404 });
            case 'npm-error':
                return NextResponse.json({ error: `NPM API returned ${result.status}` }, { status: 502 });
            case 'removed':
                return NextResponse.json({ removed: true, domain: result.domain, id: result.id });
        }
    } catch (error) {
        logger.error('api:nginx:proxy-hosts:delete', 'Failed to delete proxy host', error);
        return NextResponse.json({ error: 'Failed to delete proxy host' }, { status: 500 });
    }
});

const GetQuery = z.object({
    node: z.string().optional(),
});

/**
 * GET /api/system/nginx/proxy-hosts[?node=<n>]
 *
 * #2140 — NPM's LIVE per-host status (`enabled`, `meta.nginx_online`,
 * `meta.nginx_err`) so a broken conf is visible without reading NPM's
 * sqlite by hand. Cookie- or scoped-token-gated (read scope).
 */
export const GET = withApiHandler<undefined, z.infer<typeof GetQuery>>(
  { query: GetQuery, tokenScope: 'read' },
  async ({ query }) => {
    try {
        const result = await listLiveProxyHosts(query.node);
        switch (result.kind) {
            case 'npm-not-found':
                return NextResponse.json(NPM_NOT_FOUND, { status: 404 });
            case 'auth-failed':
                return npmAuthFailed(result.adminUrl, 'Could not authenticate with NPM.');
            case 'npm-error':
                return NextResponse.json({ error: `NPM API returned ${result.status}` }, { status: 502 });
            case 'ok':
                return NextResponse.json({ node: result.node, hosts: result.hosts });
        }
    } catch (error) {
        logger.error('api:nginx:proxy-hosts:get', 'Failed to read proxy hosts', error);
        return NextResponse.json({ error: 'Failed to read proxy hosts' }, { status: 500 });
    }
});
