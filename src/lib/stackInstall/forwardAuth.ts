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
 * Kept identical to the FileBrowser-shipped variant so the helper can
 * be back-substituted into `templates/file-share/variables.json`
 * without a behaviour change.
 */
export const AUTHELIA_FORWARD_AUTH_SNIPPET = [
  'auth_request /authelia;',
  'auth_request_set $target_url $scheme://$http_host$request_uri;',
  'auth_request_set $user $upstream_http_remote_user;',
  'auth_request_set $groups $upstream_http_remote_groups;',
  'auth_request_set $name $upstream_http_remote_name;',
  'auth_request_set $email $upstream_http_remote_email;',
  'proxy_set_header Remote-User $user;',
  'proxy_set_header Remote-Groups $groups;',
  'proxy_set_header Remote-Name $name;',
  'proxy_set_header Remote-Email $email;',
  'error_page 401 =302 https://auth.{{PUBLIC_DOMAIN}}/?rd=$target_url;',
  '',
  'location = /authelia {',
  '    internal;',
  '    proxy_pass http://127.0.0.1:{{AUTHELIA_PORT}}/api/verify;',
  '    proxy_pass_request_body off;',
  '    proxy_set_header Content-Length "";',
  '    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;',
  '    proxy_set_header X-Real-IP $remote_addr;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Forwarded-Proto $scheme;',
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
