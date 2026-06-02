/**
 * Branded, solution-pointing proxy error pages (#1583).
 *
 * Generalises the #1415 LAN-only 403 explainer mechanism to two more
 * dead-ends a user can hit on a `*.dopp.cloud` host, both of which otherwise
 * surface as a bare, unbranded openresty error page:
 *
 *   1. **Unknown / unconfigured subdomain.** A typo (e.g. `lldap.dopp.cloud`
 *      with two L's) or a never-configured host resolves to the box via the
 *      AdGuard wildcard, hits NPM's catch-all "dead host" server, and gets a
 *      raw `404`/`Authorization Required`. We serve a branded explainer that
 *      says the host isn't a configured service, links the dashboard, and
 *      suggests checking the spelling / AdGuard rewrites.
 *
 *   2. **Bare proxy error that leaks to the user on a *configured* host.** A
 *      `401` where the Authelia login redirect didn't fire, or a `502`/`504`
 *      when the upstream is down — openresty's default body says nothing. We
 *      serve a branded page that states what happened and the next step
 *      (sign in at `auth.<domain>`, or "this service is starting / offline").
 *
 * Mechanism mirrors {@link ./lanDeniedPage} exactly (it is the proven #1415
 * pattern): ship small, self-contained HTML files into NPM's `/data` volume
 * and wire `error_page` directives at it, so the page renders straight out of
 * nginx even when the ServiceBay backend is down.
 *
 *   - The unknown-host page is wired into NPM's **default/dead-host** server
 *     via the documented `/data/nginx/custom/server_dead.conf` include (the
 *     catch-all for any host without a matching proxy_host).
 *   - The bare-proxy-error page is wired per-configured-host via the same
 *     `advanced_config` append path #1415 uses, generalised to 401/502/504.
 *
 * `error_page <code> /…` (no `=`) preserves the original status code — the
 * request still failed, the user just gets an explanation instead of a wall.
 */
import { agentManager } from '@/lib/agent/manager';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';

/** Paths INSIDE the NPM container (its `/data` volume). */
export const UNKNOWN_HOST_PAGE_CONTAINER_PATH = '/data/nginx/servicebay/unknown-host.html';
export const PROXY_ERROR_PAGE_CONTAINER_PATH = '/data/nginx/servicebay/proxy-error.html';

/**
 * Host-side paths under NPM's bind-mounted data volume. Mirrors the
 * proxy_host conf root the route already writes, so a single hard-coded data
 * root keeps every writer consistent (same as {@link ./lanDeniedPage}).
 */
const NPM_DATA_ROOT = '/mnt/data/stacks/nginx-proxy-manager/data/nginx';
export const UNKNOWN_HOST_PAGE_HOST_PATH = `${NPM_DATA_ROOT}/servicebay/unknown-host.html`;
export const PROXY_ERROR_PAGE_HOST_PATH = `${NPM_DATA_ROOT}/servicebay/proxy-error.html`;

/**
 * Host-side path of NPM's documented dead-host custom include. NPM includes
 * this file inside the catch-all "dead host" server block (the one that
 * serves any host without a matching proxy_host), so it is the hook for the
 * default server.
 */
export const DEAD_HOST_CUSTOM_CONF_HOST_PATH = `${NPM_DATA_ROOT}/custom/server_dead.conf`;

/** Internal URIs the error_pages re-route to. Kept distinct from real paths. */
const UNKNOWN_HOST_INTERNAL_URI = '/servicebay-unknown-host';
const PROXY_ERROR_INTERNAL_URI = '/servicebay-proxy-error';

/** Sentinel markers for idempotent appends / detection. */
const UNKNOWN_HOST_MARKER = '# servicebay-unknown-host-explainer (#1583)';
const PROXY_ERROR_MARKER = '# servicebay-proxy-error-explainer (#1583)';

/**
 * The dead-host server include: re-route the catch-all's errors to the
 * branded unknown-host page. The default dead host normally returns a bare
 * 404 (NPM) / 401 (openresty); covering 401/403/404/500/502/503/504 here
 * means any unconfigured host renders the explainer regardless of which raw
 * code the default server would have produced.
 */
export const DEAD_HOST_CUSTOM_CONF = [
  UNKNOWN_HOST_MARKER,
  `error_page 401 403 404 500 502 503 504 ${UNKNOWN_HOST_INTERNAL_URI};`,
  `location = ${UNKNOWN_HOST_INTERNAL_URI} {`,
  '    internal;',
  '    default_type text/html;',
  `    alias ${UNKNOWN_HOST_PAGE_CONTAINER_PATH};`,
  '}',
].join('\n');

/**
 * Per-configured-host `advanced_config` snippet: wire bare 401/502/504 to the
 * branded proxy-error page. `ssi on` so the page can echo `$status`.
 *
 * 401 — Authelia login redirect didn't fire (e.g. forward-auth misconfig);
 * 502/504 — the upstream service is down or starting. 403 is deliberately
 * NOT covered here: the LAN-only deny path owns 403 (#1415).
 */
export const PROXY_ERROR_ADVANCED_CONFIG = [
  PROXY_ERROR_MARKER,
  `error_page 401 502 503 504 ${PROXY_ERROR_INTERNAL_URI};`,
  `location = ${PROXY_ERROR_INTERNAL_URI} {`,
  '    internal;',
  '    ssi on;',
  '    default_type text/html;',
  `    alias ${PROXY_ERROR_PAGE_CONTAINER_PATH};`,
  '}',
].join('\n');

/**
 * Append the branded proxy-error directives to an existing `advanced_config`
 * (which may carry forward-auth, the LAN-denied #1415 block, timeouts, …).
 * Idempotent: a config already carrying the marker is returned unchanged.
 */
export function withProxyErrorPage(advancedConfig: string | undefined): string {
  const base = advancedConfig ?? '';
  if (base.includes(PROXY_ERROR_MARKER)) return base;
  if (base.trim() === '') return PROXY_ERROR_ADVANCED_CONFIG;
  return `${base.replace(/\s*$/, '')}\n\n${PROXY_ERROR_ADVANCED_CONFIG}`;
}

/**
 * Build the branded "this host isn't a configured service" explainer. Links
 * the dashboard and the auth portal under the operator's public domain so a
 * user who fat-fingered a subdomain has a one-click way back. Self-contained:
 * inline CSS, no external assets, no JS, no backend dependency.
 *
 * @param publicDomain e.g. `dopp.cloud`. When empty, links are omitted and
 *   the copy degrades to "open your ServiceBay dashboard" without a URL.
 */
export function buildUnknownHostPageHtml(publicDomain?: string): string {
  const domain = (publicDomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const dashboardUrl = domain ? `https://${domain}` : '';
  const authUrl = domain ? `https://auth.${domain}` : '';
  const dashboardLink = dashboardUrl
    ? `<a href="${dashboardUrl}">${dashboardUrl}</a>`
    : 'your ServiceBay dashboard';
  const authLine = authUrl
    ? `<li>If you meant to sign in, go to <a href="${authUrl}">${authUrl}</a>.</li>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This service isn't set up here</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <main class="card">
    <p class="brand">ServiceBay</p>
    <h1>This service isn't set up here</h1>
    <p>The address you opened doesn't match any service configured on this ServiceBay. It's most often a small typo in the subdomain.</p>
    <p>Try this:</p>
    <ol>
      <li><strong>Check the spelling</strong> of the part before the dot (for example <code>ldap</code>, not <code>lldap</code>).</li>
      <li><strong>Open ${dashboardLink}</strong> to see the services that actually exist and pick the right one.</li>
      ${authLine}
      <li>If you just added this service, make sure its <strong>AdGuard DNS rewrite</strong> exists and its proxy host is configured, then reload.</li>
    </ol>
    <p class="footer">You reached the ServiceBay reverse proxy, but no service answers for this hostname.</p>
  </main>
</body>
</html>
`;
}

/**
 * Build the branded bare-proxy-error page (401 / 502 / 503 / 504 leaking
 * through a configured host). Shows the live status via nginx SSI and lists
 * the next step for each case. Self-contained.
 *
 * @param publicDomain used to link `auth.<domain>` for the 401 case.
 */
export function buildProxyErrorPageHtml(publicDomain?: string): string {
  const domain = (publicDomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const authUrl = domain ? `https://auth.${domain}` : '';
  const signInLink = authUrl
    ? `sign in at <a href="${authUrl}">${authUrl}</a>`
    : 'sign in through your ServiceBay login page';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This service couldn't be reached</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <main class="card">
    <p class="brand">ServiceBay</p>
    <h1>This service couldn't be reached</h1>
    <p>The proxy answered with an error (HTTP <span class="ip"><!--# echo var="status" encoding="none" --></span>) before the service could respond.</p>
    <p>What to try next:</p>
    <ol>
      <li><strong>If you weren't signed in</strong> (error 401): ${signInLink}, then reopen this page.</li>
      <li><strong>If the service is starting or offline</strong> (error 502/503/504): wait about a minute and reload &mdash; it may still be coming up. If it stays down, check the service in your ServiceBay dashboard.</li>
    </ol>
    <p class="footer">The address is correct &mdash; the service behind it just didn't respond successfully.</p>
  </main>
</body>
</html>
`;
}

/**
 * Shared inline stylesheet (matches the #1415 LAN-denied page's slate
 * palette so all three branded pages look like one family).
 */
const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    line-height: 1.55;
  }
  .card {
    width: 100%;
    max-width: 560px;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 32px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  }
  h1 { font-size: 1.4rem; margin: 0 0 16px; color: #f8fafc; }
  .brand { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin: 0 0 20px; }
  p { margin: 0 0 14px; color: #cbd5e1; }
  .ip {
    display: inline-block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 2px 8px;
    color: #f1f5f9;
  }
  a { color: #60a5fa; }
  ol { margin: 8px 0 18px; padding-left: 22px; color: #cbd5e1; }
  ol li { margin: 0 0 8px; }
  .footer { margin: 18px 0 0; font-size: 0.85rem; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #f1f5f9; }`;

/**
 * Ship a single file into NPM's data volume via the agent's sudo write
 * (NPM's container writes `/data` as root, same as #1415). Best-effort:
 * returns `false` (logged) on any failure rather than throwing, so a write
 * hiccup never fails an install — the worst case is the old bare openresty
 * page, exactly the pre-#1583 behaviour.
 */
async function shipFile(node: string | undefined, path: string, content: string, label: string): Promise<boolean> {
  try {
    const nodes = await listNodes();
    const nodeName = node ?? nodes[0]?.Name ?? 'Local';
    const agent = agentManager.getAgent(nodeName);
    const res = (await agent.sendCommand('write_file', {
      path,
      content,
      sudo: true,
    })) as { result?: string; error?: string };
    if (res?.error) {
      logger.warn('ProxyHosts', `Failed to deploy ${label}: ${res.error}`);
      return false;
    }
    logger.info('ProxyHosts', `Deployed ${label} to ${path}`);
    return true;
  } catch (e) {
    logger.warn('ProxyHosts', `Failed to deploy ${label}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Deploy all branded proxy error pages + wire the default/dead-host server.
 * Ships the two HTML files and the dead-host custom include in one go.
 * Best-effort throughout; returns `true` only if every write succeeded.
 *
 * Call once per install batch (like {@link ./lanDeniedPage#deployLanDeniedPage}).
 */
export async function deployProxyErrorPages(publicDomain?: string, node?: string): Promise<boolean> {
  const unknownOk = await shipFile(
    node,
    UNKNOWN_HOST_PAGE_HOST_PATH,
    buildUnknownHostPageHtml(publicDomain),
    'unknown-host explainer page',
  );
  const errorOk = await shipFile(
    node,
    PROXY_ERROR_PAGE_HOST_PATH,
    buildProxyErrorPageHtml(publicDomain),
    'branded proxy-error page',
  );
  const deadHostOk = await shipFile(
    node,
    DEAD_HOST_CUSTOM_CONF_HOST_PATH,
    `${DEAD_HOST_CUSTOM_CONF}\n`,
    'default/dead-host error_page include',
  );
  return unknownOk && errorOk && deadHostOk;
}
