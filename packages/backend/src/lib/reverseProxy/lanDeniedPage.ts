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

/* -------------------------------------------------------------------------
 * #1684 — forward-auth (Authelia authorization deny) 403 explainer.
 *
 * A forward-auth host's 403 is NOT the LAN-only deny: it's Authelia saying
 * "you ARE signed in, but you're not in the group this service requires"
 * (or an upstream-app 403). Routing that 403 to the LAN-only page above is
 * misleading — the user is on the LAN, signed in, and just missing a group.
 *
 * ServiceBay owns the Authelia `access_control.rules` (templates/auth/
 * configuration.yml.mustache), so it KNOWS each domain's required subject:
 *   - admin / nginx / dns / ldap     → group `admins`
 *   - everything else (`*.<domain>`) → group `family` or `admins`
 * We surface that required group, plus WHO the user is, on the deny page.
 *
 * The signed-in identity comes for free: the forward-auth snippet already
 * runs `auth_request_set $user $upstream_http_remote_user` /
 * `$groups $upstream_http_remote_groups` (forwardAuth.ts), and Authelia
 * returns Remote-User/Remote-Groups on the deny response too, so nginx has
 * `$user` / `$groups` in scope at error_page time. The page echoes them via
 * SSI — same self-contained, backend-independent mechanism as #1415.
 * ---------------------------------------------------------------------- */

/**
 * The forward-auth deny page is HOST-SPECIFIC — it bakes in the required
 * group for that domain's access_control rule (admin hosts need `admins`,
 * others `family`/`admins`). So each forward-auth host gets its own file,
 * slugged by domain, rather than one shared page (which would clobber).
 */
function forwardAuthDeniedSlug(domain: string): string {
  return (domain || 'host').toLowerCase().replace(/[^a-z0-9.-]/g, '_');
}

/** Path of a host's forward-auth deny explainer INSIDE the NPM container. */
export function forwardAuthDeniedContainerPath(domain: string): string {
  return `/data/nginx/servicebay/forward-auth-denied-${forwardAuthDeniedSlug(domain)}.html`;
}

/** Host-side path of a host's forward-auth deny explainer under NPM's data volume. */
export function forwardAuthDeniedHostPath(domain: string): string {
  return `/mnt/data/stacks/nginx-proxy-manager/data/nginx/servicebay/forward-auth-denied-${forwardAuthDeniedSlug(domain)}.html`;
}

/** Internal URI the forward-auth 403 is re-routed to. */
const FORWARD_AUTH_DENIED_INTERNAL_URI = '/servicebay-forward-auth-denied';

/** Sentinel marker for idempotent appends / detection. */
const FORWARD_AUTH_DENIED_MARKER = '# servicebay-forward-auth-denied-explainer (#1684)';

/** Admin-only subdomains per the auth template's access_control rules. */
const ADMIN_ONLY_SUBDOMAINS = new Set(['admin', 'nginx', 'dns', 'ldap']);

/**
 * Derive the group(s) that grant access to a domain, from the Authelia
 * `access_control.rules` ServiceBay generates (templates/auth/
 * configuration.yml.mustache). Pure + deterministic — mirrors the rule
 * table so the deny page can name the required group without reading the
 * live config:
 *   - admin / nginx / dns / ldap     → `['admins']`
 *   - anything else                  → `['family', 'admins']`
 *
 * `domain` may be a bare host (`ollama.dopp.cloud`) or just the leftmost
 * label; only the first label is inspected.
 */
export function requiredGroupsForDomain(domain: string | undefined): string[] {
  const label = (domain ?? '').trim().toLowerCase().split('.')[0] ?? '';
  return ADMIN_ONLY_SUBDOMAINS.has(label) ? ['admins'] : ['family', 'admins'];
}

/**
 * The nginx directives that wire a forward-auth host's 403 to the branded
 * deny page. `ssi on` so the page can echo `$user` / `$groups`. The required
 * group is baked into the served HTML per-host (so it can be SSI-free), not
 * into this snippet — keeping the snippet identical across hosts and
 * idempotent on the marker.
 *
 * `error_page 403 /…` (no `=`) preserves the original 403 — the request is
 * still denied, the user just gets an explanation of WHICH group they need.
 */
export function forwardAuthDeniedAdvancedConfig(domain: string): string {
  return [
    FORWARD_AUTH_DENIED_MARKER,
    `error_page 403 ${FORWARD_AUTH_DENIED_INTERNAL_URI};`,
    `location = ${FORWARD_AUTH_DENIED_INTERNAL_URI} {`,
    '    internal;',
    '    ssi on;',
    '    default_type text/html;',
    `    alias ${forwardAuthDeniedContainerPath(domain)};`,
    '}',
  ].join('\n');
}

/**
 * Append the forward-auth deny directives to an existing `advanced_config`.
 * Idempotent on {@link FORWARD_AUTH_DENIED_MARKER}; preserves any existing
 * directives (the forward-auth block itself, timeouts, the #1583 proxy-error
 * block, …). Mirrors {@link withLanDeniedPage}.
 *
 * NOTE: a host is EITHER LAN-only (gets {@link withLanDeniedPage}) OR
 * forward-auth (gets this) for its 403 routing — never both, so the two
 * `error_page 403` directives never collide on one host.
 */
export function withForwardAuthDeniedPage(advancedConfig: string | undefined, domain: string): string {
  const base = advancedConfig ?? '';
  if (base.includes(FORWARD_AUTH_DENIED_MARKER)) return base;
  const snippet = forwardAuthDeniedAdvancedConfig(domain);
  if (base.trim() === '') return snippet;
  return `${base.replace(/\s*$/, '')}\n\n${snippet}`;
}

/** Render the required-group phrase: `family` or `admins`. */
function renderRequiredGroups(groups: string[]): string {
  const quoted = groups.map((g) => `<code>${g}</code>`);
  if (quoted.length <= 1) return quoted[0] ?? '';
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/**
 * Build the branded forward-auth deny explainer for a specific host. Names
 * WHAT'S REQUIRED (the group that grants access, baked in from the domain's
 * access_control rule) and WHO the user is (signed-in `$user` + `$groups`,
 * echoed live via nginx SSI). Self-contained: inline CSS, no external assets,
 * no JS, no ServiceBay-backend dependency — renders straight out of nginx.
 *
 * Distinct from the LAN-only page (#1415): the user here IS on the network and
 * IS signed in; they're just missing a group. The copy says exactly that and
 * points them at asking an admin to add the group.
 *
 * @param domain the host this page is served for (e.g. `ollama.dopp.cloud`).
 * @param publicDomain operator's public domain, used to link `auth.<domain>`.
 */
const FORWARD_AUTH_DENIED_CSS = `
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
  .ip, code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #f1f5f9;
  }
  .ip {
    display: inline-block;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 2px 8px;
  }
  a { color: #60a5fa; }
  ol { margin: 8px 0 18px; padding-left: 22px; color: #cbd5e1; }
  ol li { margin: 0 0 8px; }
  .footer { margin: 18px 0 0; font-size: 0.85rem; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; }`;

export function buildForwardAuthDeniedPageHtml(domain?: string, publicDomain?: string): string {
  const host = (domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const hostLabel = host || 'This service';
  const requiredPhrase = renderRequiredGroups(requiredGroupsForDomain(host));
  const pubDomain = (publicDomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const authUrl = pubDomain ? `https://auth.${pubDomain}` : '';
  const signOutLine = authUrl
    ? `<li>If you signed in with the wrong account, sign out at <a href="${authUrl}">${authUrl}</a> and sign back in.</li>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You don't have access to this service</title>
<style>${FORWARD_AUTH_DENIED_CSS}</style>
</head>
<body>
  <main class="card">
    <p class="brand">ServiceBay</p>
    <h1>You don't have access to this service</h1>
    <p>You're signed in, but your account isn't allowed to open <strong>${hostLabel}</strong>.</p>
    <p><strong>${hostLabel}</strong> needs group ${requiredPhrase}.</p>
    <p>You're signed in as <span class="ip"><!--# echo var="user" encoding="none" --></span> with groups <span class="ip"><!--# echo var="groups" encoding="none" --></span>.</p>
    <p>To get in:</p>
    <ol>
      <li><strong>Ask an administrator</strong> to add your account to group ${requiredPhrase}.</li>
      ${signOutLine}
    </ol>
    <p class="footer">This isn't a network or DNS problem &mdash; you reached the right service, your account just lacks the required group.</p>
  </main>
</body>
</html>
`;
}

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

/**
 * #1684 — Ship the forward-auth (Authelia authorization deny) 403 explainer
 * into NPM's data volume for a specific host, so the per-host `error_page 403`
 * → SSI location can serve it. The page is host-specific (it names the
 * required group derived from that domain's access_control rule), so unlike
 * the single LAN-only page this is written once per forward-auth host.
 * Best-effort: a write hiccup just leaves the old bare openresty 403, exactly
 * the pre-#1684 behaviour, so it must never fail an install.
 */
export async function deployForwardAuthDeniedPage(
  domain: string,
  publicDomain?: string,
  node?: string,
): Promise<boolean> {
  try {
    const nodes = await listNodes();
    const nodeName = node ?? nodes[0]?.Name ?? 'Local';
    const agent = agentManager.getAgent(nodeName);
    const hostPath = forwardAuthDeniedHostPath(domain);
    const res = (await agent.sendCommand('write_file', {
      path: hostPath,
      content: buildForwardAuthDeniedPageHtml(domain, publicDomain),
      sudo: true,
    })) as { result?: string; error?: string };
    if (res?.error) {
      logger.warn('ProxyHosts', `Failed to deploy forward-auth deny explainer for ${domain}: ${res.error}`);
      return false;
    }
    logger.info('ProxyHosts', `Deployed forward-auth 403 explainer for ${domain} to ${hostPath}`);
    return true;
  } catch (e) {
    logger.warn('ProxyHosts', `Failed to deploy forward-auth deny explainer for ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
