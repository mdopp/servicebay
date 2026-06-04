/**
 * Shared NPM `advanced_config` block for services that gate their UI
 * behind Authelia via the `forward_auth` pattern (#495).
 *
 * Three+ services use the same nginx snippet now (FileBrowser already,
 * AdGuard + Syncthing being wired). Rather than copy-paste the same
 * 600-character block into every `variables.json`, templates set
 * `advanced_config: "__authelia_forward_auth__"` (the
 * `AUTHELIA_FORWARD_AUTH_SENTINEL` value below) and the install runner
 * expands it via `expandForwardAuthSentinel` right before Mustache
 * renders cross-template placeholders like `{{AUTHELIA_PORT}}`.
 *
 * Adding `__authelia_forward_auth__:` followed by extra nginx
 * directives lets a template tack service-specific config (e.g.
 * upload size limits) onto the end. Everything after the sentinel
 * line is appended verbatim to the rendered snippet.
 */

export const AUTHELIA_FORWARD_AUTH_SENTINEL = '__authelia_forward_auth__';

/**
 * #1677 — Authelia's nginx forward-auth port. The forward-auth snippet
 * references `{{AUTHELIA_PORT}}`; when the `auth` template isn't in the
 * same install batch as a gated service the Mustache `view` carries no
 * AUTHELIA_PORT and the placeholder renders empty, producing
 * `proxy_pass http://127.0.0.1:/api/authz/...` — an invalid nginx
 * upstream that crashes the WHOLE reverse proxy on the next reload.
 * Always fall back to this concrete default rather than emit an empty
 * port. 9091 is Authelia's fixed container port across every template.
 */
export const DEFAULT_AUTHELIA_PORT = '9091';

/**
 * #1677 defense-in-depth — repair a forward-auth `proxy_pass` whose
 * Authelia port came out empty (`127.0.0.1:/api/authz/...`). NPM stores
 * the bad `advanced_config` in its DB, so it regenerates the broken
 * `.conf` on every host rebuild; this sanitiser runs on the on-disk conf
 * just before nginx reloads it. Idempotent: a conf with a concrete port
 * is returned unchanged. Returns `{ content, repaired }`.
 */
export function sanitizeForwardAuthPort(
  content: string,
  port: string = DEFAULT_AUTHELIA_PORT,
): { content: string; repaired: boolean } {
  // Match the auth-request upstream specifically so we never touch a
  // legitimately port-less proxy_pass elsewhere in the conf.
  const empty = /proxy_pass\s+http:\/\/127\.0\.0\.1:\/api\/authz\//g;
  if (!empty.test(content)) return { content, repaired: false };
  return {
    content: content.replace(
      /proxy_pass(\s+)http:\/\/127\.0\.0\.1:\/api\/authz\//g,
      `proxy_pass$1http://127.0.0.1:${port}/api/authz/`,
    ),
    repaired: true,
  };
}

/**
 * #999 — proxy_set_header directives we want on the UPSTREAM request
 * (Remote-User et al. coming back from Authelia's auth-request). nginx
 * inheritance drops server-level proxy_set_header when the location /
 * block has any of its own (which NPM's bundled proxy.conf always
 * does), so these must land inside `location / { }` to actually reach
 * the upstream. Used by the post-create reconciler in
 * `/api/system/nginx/proxy-hosts/route.ts` to patch the generated
 * .conf via sudo write_file — see #999 for the architectural notes
 * on why the location is the right place.
 */
export const AUTHELIA_LOCATION_HEADERS = [
  'proxy_set_header Remote-User $user;',
  'proxy_set_header Remote-Groups $groups;',
  'proxy_set_header Remote-Name $name;',
  'proxy_set_header Remote-Email $email;',
].join('\n    ');

/**
 * The actual nginx config block. References `{{PUBLIC_DOMAIN}}` and
 * `{{AUTHELIA_PORT}}` so it survives the Mustache pass that turns
 * cross-template placeholders into concrete values at install time.
 *
 * **Endpoint:** `/api/authz/auth-request`, NOT `/api/authz/forward-auth`.
 * Authelia 4.38+ exposes two distinct endpoints for proxy integration:
 * - `forward-auth` returns a 302 with a `Location` header (for Traefik,
 *   Caddy — proxies that follow redirects themselves).
 * - `auth-request` returns 401 plus the Location in a response header
 *   (for nginx `ngx_http_auth_request_module`, which only accepts
 *   2xx/401 from the subrequest and silently treats 3xx as 5xx).
 *
 * Using `forward-auth` from an nginx `auth_request` directive surfaces
 * as `"auth request unexpected status: 302"` in `error.log` and the
 * client gets 500. Live-fixed 2026-05-17 after a v3.42.0 install left
 * every gated subdomain returning 500.
 *
 * The auth-request endpoint also keeps Authelia's legacy header API:
 * `X-Original-URL` + `X-Original-Method` carry the request, NOT the
 * `X-Forwarded-*` set that the forward-auth endpoint expects.
 *
 * Authelia validates the scheme in `X-Original-URL` — anything other
 * than `https://` triggers *"Target URL has an insecure scheme 'http',
 * only the 'https' and 'wss' schemes are supported so session cookies
 * can be transmitted securely"* and a 400. So this snippet is only
 * useful on hosts that actually serve traffic over HTTPS (= have a
 * cert bound). For cert-less LAN-only hosts, gate auth differently
 * (or don't gate at all).
 *
 * `error_page 401 =302 $redirect` converts the 401 back to a 302 the
 * browser can follow; `$redirect` is captured from
 * `$upstream_http_location` which Authelia populates with the correct
 * `auth.<domain>/?rd=<original>` URL.
 */
export const AUTHELIA_FORWARD_AUTH_SNIPPET = [
  'auth_request /authelia;',
  'auth_request_set $target_url $scheme://$http_host$request_uri;',
  'auth_request_set $user $upstream_http_remote_user;',
  'auth_request_set $groups $upstream_http_remote_groups;',
  'auth_request_set $name $upstream_http_remote_name;',
  'auth_request_set $email $upstream_http_remote_email;',
  'auth_request_set $redirect $upstream_http_location;',
  'proxy_set_header Remote-User $user;',
  'proxy_set_header Remote-Groups $groups;',
  'proxy_set_header Remote-Name $name;',
  'proxy_set_header Remote-Email $email;',
  'error_page 401 =302 $redirect;',
  '',
  'location = /authelia {',
  '    internal;',
  '    proxy_pass http://127.0.0.1:{{AUTHELIA_PORT}}/api/authz/auth-request;',
  '    proxy_pass_request_body off;',
  '    proxy_set_header Content-Length "";',
  '    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;',
  '    proxy_set_header X-Original-Method $request_method;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Real-IP $remote_addr;',
  '}',
  '',
  '# #1680 — Let LE HTTP-01 through on :80. The server-level',
  '# `auth_request /authelia` above is inherited by every location,',
  '# including the ACME challenge — but Authelia\'s auth-request endpoint',
  '# is https-only and 400s the plain-http challenge (→ 500), so certbot',
  '# never gets its token and issuance fails. Disable forward-auth for the',
  '# challenge path and serve it from NPM\'s webroot so the challenge is',
  '# never swallowed by forward-auth.',
  'location /.well-known/acme-challenge/ {',
  '    auth_request off;',
  '    allow all;',
  '    root /data/letsencrypt-acme-challenge;',
  '}',
].join('\n');

/**
 * Expand the sentinel value (if present) to the full snippet. Anything
 * other than the sentinel is returned unchanged so templates that
 * still ship the verbatim block (or use a different `advanced_config`
 * entirely) keep working.
 *
 * A template can append extra nginx directives by writing
 * `__authelia_forward_auth__\n<extra config>` — anything past the
 * sentinel line is glued onto the end of the rendered snippet.
 */
export function expandForwardAuthSentinel(advancedConfig: string | undefined): string | undefined {
  if (!advancedConfig) return advancedConfig;
  if (advancedConfig === AUTHELIA_FORWARD_AUTH_SENTINEL) {
    return AUTHELIA_FORWARD_AUTH_SNIPPET;
  }
  // Prefix form: `__authelia_forward_auth__\n<extras>`.
  if (advancedConfig.startsWith(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\n`)) {
    const extras = advancedConfig.slice(AUTHELIA_FORWARD_AUTH_SENTINEL.length + 1);
    return `${AUTHELIA_FORWARD_AUTH_SNIPPET}\n${extras}`;
  }
  return advancedConfig;
}
