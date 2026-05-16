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
 * The actual nginx config block. References `{{PUBLIC_DOMAIN}}` and
 * `{{AUTHELIA_PORT}}` so it survives the Mustache pass that turns
 * cross-template placeholders into concrete values at install time.
 *
 * **Authelia 4.38+ endpoint:** `/api/authz/forward-auth`. The legacy
 * `/api/verify` was deprecated in v4.38 — Authelia 4.39 refuses to
 * read the (Secure) session cookie when /api/verify is called over
 * `http://` (logs: *"Target URL 'http://127.0.0.1:9091/api/verify'
 * has an insecure scheme 'http', only the 'https' and 'wss' schemes
 * are supported so session cookies can be transmitted securely"*).
 * Operators saw FileBrowser bounce them to its local login form with
 * an empty `Remote-User` header even with a valid Authelia session;
 * root cause traced via container logs (Authelia kept logging the
 * verify request as `user=<anonymous>`). The new endpoint takes the
 * forwarded URL via `X-Forwarded-*` headers and is transport-aware,
 * so the cookie is read correctly even when nginx proxies to it
 * over http on the loopback.
 *
 * Also drops the explicit `error_page 401 =302` redirect — the new
 * endpoint returns a 302 with the correct `Location: auth.<domain>`
 * header on its own when the user isn't authenticated, so we don't
 * need to rewrite the status code on the nginx side.
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
  // Authelia's forward-auth endpoint already returns a Location header
  // pointing at the auth portal with the correct rd= param; honour it
  // verbatim. Fall back to the bare portal URL if no Location came back
  // (e.g. transient Authelia error) so the operator at least lands
  // somewhere they can re-authenticate.
  'error_page 401 =302 $redirect;',
  '',
  'location = /authelia {',
  '    internal;',
  '    proxy_pass http://127.0.0.1:{{AUTHELIA_PORT}}/api/authz/forward-auth;',
  '    proxy_pass_request_body off;',
  '    proxy_set_header Content-Length "";',
  '    proxy_set_header X-Forwarded-Method $request_method;',
  '    proxy_set_header X-Forwarded-Proto $scheme;',
  '    proxy_set_header X-Forwarded-Host $http_host;',
  '    proxy_set_header X-Forwarded-Uri $request_uri;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Real-IP $remote_addr;',
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
