/**
 * Branded "this host is LAN-only" 403 explainer (#1415).
 *
 * The 6 LAN-only NPM hosts (admin, nginx, ldap, dns, zwave, sync) bind the
 * auto-managed "ServiceBay LAN only" access list, whose final rule is
 * `deny all`. A client that resolves the public A record while off-LAN — the
 * common transient Pattern-B DNS fallback, where a brief AdGuard gap lets a
 * fallback resolver cache the public record — hits that deny and gets
 * openresty's bare, unbranded `403 Forbidden`. That looks like a broken site
 * or an attack to the operator; it is almost always a stale DNS answer that
 * self-heals once the public TTL (150s) expires.
 *
 * Root cause is verified and the access rule is intentionally UNCHANGED: a
 * hairpinned LAN client is indistinguishable from a WAN attacker after NAT,
 * so we cannot allow the traffic (Pattern A was rejected by design). We only
 * replace the *denied-response body* with a self-explaining page.
 *
 * Mechanism (avoids the nginx `return`-loop):
 *   - Ship a small, self-contained HTML file into NPM's data volume
 *     (`/data/nginx/servicebay/lan-denied.html` inside the container).
 *   - Per-host `advanced_config` adds `error_page 403 = /…` pointing at an
 *     `internal` SSI-enabled `location` that `alias`es that file.
 *   - The page shows the live client IP via nginx SSI
 *     (`<!--# echo var="remote_addr" -->`), renders with inline CSS and no
 *     external assets, and does NOT depend on the ServiceBay backend being up.
 *
 * The page deliberately keeps the response at HTTP 403 (the `error_page`
 * directive preserves the original status) — the request is still denied,
 * the operator just gets an explanation instead of a blank wall.
 */
import { agentManager } from '@/lib/agent/manager';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';

/**
 * Path of the explainer file INSIDE the NPM container (its `/data` volume).
 * Referenced by the `alias` directive in the generated `advanced_config`.
 */
export const LAN_DENIED_PAGE_CONTAINER_PATH = '/data/nginx/servicebay/lan-denied.html';

/**
 * Host-side path of the explainer file, under NPM's bind-mounted data
 * volume. Mirrors the proxy_host conf path the route already writes
 * (`/mnt/data/stacks/nginx-proxy-manager/data/nginx/proxy_host/<id>.conf`),
 * so a single hard-coded data root keeps both writers consistent.
 */
export const LAN_DENIED_PAGE_HOST_PATH =
  '/mnt/data/stacks/nginx-proxy-manager/data/nginx/servicebay/lan-denied.html';

/** Internal URI the 403 is re-routed to. Kept distinct from any real path. */
const DENIED_INTERNAL_URI = '/servicebay-lan-only';

/** Sentinel comment so the snippet can be detected for idempotent appends. */
const SNIPPET_MARKER = '# servicebay-lan-only-explainer (#1415)';

/**
 * The nginx directives appended to a LAN-only host's `advanced_config`.
 * NPM places `advanced_config` in the `server` block, so `error_page` and
 * the `location` are both server-scoped. The location is `internal` (only
 * reachable via the internal error_page redirect, never directly), enables
 * SSI so `remote_addr` is substituted, and `alias`es the shipped HTML file.
 *
 * `error_page 403 /…` (no `=`) preserves the original 403 status, which is
 * what we want — the request is still denied.
 */
export const LAN_DENIED_ADVANCED_CONFIG = [
  SNIPPET_MARKER,
  `error_page 403 ${DENIED_INTERNAL_URI};`,
  `location = ${DENIED_INTERNAL_URI} {`,
  '    internal;',
  '    ssi on;',
  '    default_type text/html;',
  `    alias ${LAN_DENIED_PAGE_CONTAINER_PATH};`,
  '}',
].join('\n');

/**
 * Append the LAN-only explainer directives to an existing `advanced_config`
 * (which may carry forward-auth, timeouts, etc.). Idempotent: a config that
 * already contains the snippet marker is returned unchanged, so re-running
 * the provisioner on an existing host doesn't duplicate the block.
 */
export function withLanDeniedPage(advancedConfig: string | undefined): string {
  const base = advancedConfig ?? '';
  if (base.includes(SNIPPET_MARKER)) return base;
  if (base.trim() === '') return LAN_DENIED_ADVANCED_CONFIG;
  return `${base.replace(/\s*$/, '')}\n\n${LAN_DENIED_ADVANCED_CONFIG}`;
}

/**
 * The branded explainer page. Self-contained: inline CSS, no external
 * assets, no JS, no dependency on the ServiceBay backend. Renders correctly
 * straight out of nginx with SSI on even when the rest of the stack is down.
 *
 * `<!--# echo var="remote_addr" -->` is substituted by nginx SSI with the
 * connecting client's IP (the post-NAT address NPM sees). `encoding="none"`
 * keeps it as the literal dotted-quad rather than URL-encoding it.
 *
 * Copy order is deliberate (least-effort, self-healing fix first):
 *   came from {ip} outside the home network → almost always a stale/fallback
 *   DNS answer, not an attack → wait ~2 min & reload (self-heals, TTL 150s)
 *   → flush device DNS → refresh FritzBox DNS cache → ensure the device uses
 *   AdGuard/FritzBox DNS not browser DoH → if genuinely remote, LAN-only by design.
 */
export const LAN_DENIED_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This page is only reachable from your home network</title>
<style>
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
  h1 { font-size: 1.4rem; margin: 0 0 4px; color: #f8fafc; }
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
  .reassure { color: #94a3b8; }
  ol { margin: 8px 0 18px; padding-left: 22px; color: #cbd5e1; }
  ol li { margin: 0 0 8px; }
  .footer { margin: 18px 0 0; font-size: 0.85rem; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #f1f5f9; }
</style>
</head>
<body>
  <main class="card">
    <p class="brand">ServiceBay</p>
    <h1>This page is only reachable from your home network</h1>
    <p>Your request came from <span class="ip"><!--# echo var="remote_addr" encoding="none" --></span>, which is outside the home network.</p>
    <p class="reassure">This is almost always a stale or fallback DNS answer &mdash; not an attack or a broken site. Your device briefly looked up this address through the wrong resolver and cached the public record.</p>
    <p>It usually fixes itself. Try these in order:</p>
    <ol>
      <li><strong>Wait about 2 minutes and reload.</strong> The address self-heals once the public DNS record expires (it lives only 150 seconds).</li>
      <li><strong>Flush your device's DNS cache.</strong> On Windows: <code>ipconfig /flushdns</code>. On macOS: <code>sudo dscacheutil -flushcache</code>.</li>
      <li><strong>Refresh the FritzBox DNS cache</strong> (FRITZ!Box &rarr; Internet &rarr; Permit Access &rarr; DNS, or simply reconnect to the network).</li>
      <li><strong>Make sure this device uses your home DNS</strong> (AdGuard / FritzBox), not a browser "Secure DNS" / DNS-over-HTTPS setting that bypasses it.</li>
    </ol>
    <p class="footer">If you really are away from home: this page is LAN-only by design and stays unreachable from the internet. Use the public services or a VPN back into the home network instead.</p>
  </main>
</body>
</html>
`;

/**
 * Ship the explainer HTML into NPM's data volume so the `alias` in
 * {@link LAN_DENIED_ADVANCED_CONFIG} can serve it. Best-effort: returns
 * `false` (logged) on any failure rather than throwing — the worst case is
 * that off-LAN clients keep seeing the bare openresty 403, which is exactly
 * the pre-#1415 behaviour, so a write hiccup must never fail an install.
 *
 * Uses `sudo` because NPM's container writes its `/data` tree as root from
 * the host's perspective (same reason `patchProxyHostConfFile` does).
 */
export async function deployLanDeniedPage(node?: string): Promise<boolean> {
  try {
    const nodes = await listNodes();
    const nodeName = node ?? nodes[0]?.Name ?? 'Local';
    const agent = agentManager.getAgent(nodeName);
    const res = (await agent.sendCommand('write_file', {
      path: LAN_DENIED_PAGE_HOST_PATH,
      content: LAN_DENIED_PAGE_HTML,
      sudo: true,
    })) as { result?: string; error?: string };
    if (res?.error) {
      logger.warn('ProxyHosts', `Failed to deploy LAN-only explainer page: ${res.error}`);
      return false;
    }
    logger.info('ProxyHosts', `Deployed LAN-only 403 explainer to ${LAN_DENIED_PAGE_HOST_PATH}`);
    return true;
  } catch (e) {
    logger.warn('ProxyHosts', `Failed to deploy LAN-only explainer page: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
