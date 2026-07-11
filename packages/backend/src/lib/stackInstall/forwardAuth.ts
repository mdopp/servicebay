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
const AUTHELIA_FORWARD_AUTH_CORE = [
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
].join('\n');

/**
 * #1680 — Let LE HTTP-01 through on :80. The server-level `auth_request
 * /authelia` is inherited by every location, including the ACME challenge —
 * but Authelia's auth-request endpoint is https-only and 400s the plain-http
 * challenge (→ 500), so certbot never gets its token and issuance fails.
 * Disable forward-auth for the challenge path and serve it from NPM's webroot
 * so the challenge is never swallowed by forward-auth.
 *
 * #2143 — This block is emitted ONLY for hosts that do NOT get a Let's
 * Encrypt cert (i.e. `exposure: 'lan'`). Any host that requests an LE cert
 * (`public`/`internal`) gets an *identical* `location /.well-known/acme-
 * challenge/` block injected by NPM itself → two identical locations →
 * `nginx: [emerg] duplicate location "/.well-known/acme-challenge/"` → NPM
 * reverts the conf and the host answers with an SSL error. So on LE hosts we
 * must NOT emit our own copy; NPM already provides it.
 */
const AUTHELIA_ACME_BYPASS = [
  'location /.well-known/acme-challenge/ {',
  '    auth_request off;',
  '    allow all;',
  '    root /data/letsencrypt-acme-challenge;',
  '}',
].join('\n');

/**
 * The full forward-auth snippet, INCLUDING the ACME-challenge bypass. Kept
 * for callers/tests that want the complete block; note that on a Let's
 * Encrypt host the bypass duplicates NPM's own acme location (#2143) — such
 * callers must pass `{ omitAcmeBypass: true }` to {@link
 * expandForwardAuthSentinel} / {@link renderForwardAuthAdvancedConfig}.
 */
export const AUTHELIA_FORWARD_AUTH_SNIPPET = `${AUTHELIA_FORWARD_AUTH_CORE}\n\n${AUTHELIA_ACME_BYPASS}`;

/** Options controlling how the sentinel expands. */
export interface ForwardAuthExpandOptions {
  /**
   * #2143 — Omit the `location /.well-known/acme-challenge/` bypass. Set
   * for hosts that get a Let's Encrypt cert (`public`/`internal` exposure),
   * where NPM injects an identical acme-challenge location — emitting our
   * own too crashes nginx with `[emerg] duplicate location`. Leave false for
   * cert-less LAN hosts (harmless there, and forward-auth still shouldn't
   * swallow a challenge if one is ever served).
   */
  omitAcmeBypass?: boolean;
  /**
   * #2210 — Path prefixes that must SKIP forward-auth while the rest of the
   * host stays gated. Each becomes an `auth_request off` location that still
   * proxies to the upstream, so e.g. `/.well-known/assetlinks.json` (Google's
   * unauthenticated Digital-Asset-Links fetch for a TWA) or `/static/` (PWA
   * icons/manifest) pass straight through. See {@link buildAuthSkipLocations}.
   */
  authSkipPaths?: string[];
  /**
   * #2205 — Strip a redundant `proxy_http_version` directive from the
   * `advanced_config` when the host has websocket upgrade enabled. NPM
   * already emits `proxy_http_version 1.1;` at server level whenever
   * `allow_websocket_upgrade` is on, so any advanced_config that ALSO sets
   * `proxy_http_version` (e.g. an SSE-tuning block) produces a DUPLICATE
   * directive → `nginx: [emerg] "proxy_http_version" directive is duplicate`
   * → the vhost is invalid and the domain returns a TLS `unrecognized_name`
   * after redeploy. Set for websocket-enabled hosts so ServiceBay never
   * emits the second copy. See {@link stripDuplicateProxyHttpVersion}.
   */
  websocket?: boolean;
}

/**
 * #2205 — Remove any `proxy_http_version` directive from an nginx config
 * block. Used only when the host has websocket upgrade enabled: NPM emits its
 * own server-level `proxy_http_version 1.1;` for websocket hosts, so a copy in
 * our `advanced_config` duplicates it and nginx rejects the whole vhost with
 * `[emerg] "proxy_http_version" directive is duplicate`. Confirmed live during
 * the #2210 work on chat.dopp.cloud (an SSE-tuning block carried its own
 * `proxy_http_version 1.1;`). Idempotent: a block with no such directive is
 * returned unchanged. We strip the directive entirely (rather than dedupe to
 * one) because on a websocket host NPM's server-level copy already provides it,
 * so ours is always redundant.
 */
export function stripDuplicateProxyHttpVersion(content: string): string {
  // Drop each full `proxy_http_version <ver>;` line, including its
  // leading whitespace and the trailing newline, so we don't leave a
  // blank line behind. Case-insensitive on the directive name only.
  return content.replace(/^[ \t]*proxy_http_version\b[^;\n]*;[ \t]*\r?\n?/gim, '');
}

/**
 * #2210 — Build `auth_request off` bypass locations for the given path
 * prefixes. Each still proxies to the upstream via NPM's own
 * `include conf.d/include/proxy.conf` — that include ALREADY contains the
 * `proxy_pass $forward_scheme://$server:$port$request_uri;` (plus the Host /
 * X-Forwarded-* headers) using NPM's server-level upstream variables, so we
 * neither need the concrete upstream NOR our own `proxy_pass` (a second one is
 * `nginx: [emerg] "proxy_pass" directive is duplicate`, confirmed live on the
 * chat.dopp.cloud conf). The bypass location therefore only adds
 * `auth_request off;` on top of that include.
 *
 * `location ^~` (longest-prefix, wins over regex) is used so a bypass beats
 * both the inherited server-level `auth_request /authelia` AND stays distinct
 * from NPM's own `location ^~ /.well-known/acme-challenge/` (a longer, more
 * specific prefix → different location string → no `duplicate location`
 * crash, and acme still routes to NPM's webroot). We explicitly refuse
 * `/.well-known/acme-challenge` here for the same reason — NPM owns it.
 */
export function buildAuthSkipLocations(paths: string[] | undefined): string {
  if (!paths?.length) return '';
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    // Absolute prefixes only; never shadow NPM's acme-challenge location.
    if (!path.startsWith('/')) continue;
    if (path.startsWith('/.well-known/acme-challenge')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    blocks.push(
      [
        `location ^~ ${path} {`,
        '    auth_request off;',
        // proxy.conf supplies proxy_pass + Host/X-Forwarded-* — do NOT add our
        // own proxy_pass (duplicate directive → nginx refuses the conf).
        '    include conf.d/include/proxy.conf;',
        '}',
      ].join('\n'),
    );
  }
  return blocks.join('\n\n');
}

function baseSnippet(opts?: ForwardAuthExpandOptions): string {
  const core = opts?.omitAcmeBypass
    ? AUTHELIA_FORWARD_AUTH_CORE
    : AUTHELIA_FORWARD_AUTH_SNIPPET;
  const skip = buildAuthSkipLocations(opts?.authSkipPaths);
  return skip ? `${core}\n\n${skip}` : core;
}

/**
 * Expand the sentinel value (if present) to the full snippet. Anything
 * other than the sentinel is returned unchanged so templates that
 * still ship the verbatim block (or use a different `advanced_config`
 * entirely) keep working.
 *
 * A template can append extra nginx directives by writing
 * `__authelia_forward_auth__\n<extra config>` — anything past the
 * sentinel line is glued onto the end of the rendered snippet.
 *
 * `opts.omitAcmeBypass` drops the acme-challenge bypass for LE hosts (#2143).
 */
export function expandForwardAuthSentinel(
  advancedConfig: string | undefined,
  opts?: ForwardAuthExpandOptions,
): string | undefined {
  if (!advancedConfig) return advancedConfig;
  // #2205 — on a websocket host, strip any redundant `proxy_http_version`
  // (NPM emits its own at server level) so we never produce a duplicate
  // directive. Applies to the sentinel's appended extras AND to a plain
  // advanced_config that carries the directive on its own.
  const sanitize = (s: string): string =>
    opts?.websocket ? stripDuplicateProxyHttpVersion(s) : s;
  const snippet = baseSnippet(opts);
  if (advancedConfig === AUTHELIA_FORWARD_AUTH_SENTINEL) {
    return snippet;
  }
  // Prefix form: `__authelia_forward_auth__\n<extras>`.
  if (advancedConfig.startsWith(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\n`)) {
    const extras = advancedConfig.slice(AUTHELIA_FORWARD_AUTH_SENTINEL.length + 1);
    return `${snippet}\n${sanitize(extras)}`;
  }
  return sanitize(advancedConfig);
}

/**
 * Fully render a forward-auth `advanced_config` for code paths that have NO
 * Mustache step — chiefly the direct proxy-host API (`/api/system/nginx/
 * proxy-hosts`), used by manual creates and diagnose/heal re-asserts. The stack
 * INSTALLER expands the sentinel then Mustache-renders `{{AUTHELIA_PORT}}`; a
 * direct API call does neither, so without this both the literal sentinel AND the
 * `{{AUTHELIA_PORT}}` placeholder land verbatim in the .conf →
 * `nginx: [emerg] unknown directive "__authelia_forward_auth__"` (and an invalid
 * `proxy_pass …:{{AUTHELIA_PORT}}/…`), leaving the host permanently offline. This
 * expands the sentinel AND substitutes the Authelia port, so the API path emits a
 * valid block exactly like the installer. A config that carries neither token is
 * returned unchanged. `port` defaults to {@link DEFAULT_AUTHELIA_PORT}.
 */
export function renderForwardAuthAdvancedConfig(
  advancedConfig: string | undefined,
  port: string = DEFAULT_AUTHELIA_PORT,
  opts?: ForwardAuthExpandOptions,
): string | undefined {
  const expanded = expandForwardAuthSentinel(advancedConfig, opts);
  if (expanded === undefined) return expanded;
  return expanded.replace(/\{\{AUTHELIA_PORT\}\}/g, port);
}
