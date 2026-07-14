import { describe, it, expect } from 'vitest';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  expandForwardAuthSentinel,
  renderForwardAuthAdvancedConfig,
  stripDuplicateProxyHttpVersion,
  buildAutheliaSessionMintLocation,
  AUTHELIA_SESSION_MINT_PATHS,
  DEFAULT_AUTHELIA_PORT,
} from './forwardAuth';

/** Count occurrences of the `proxy_http_version` directive. */
const countHttpVersion = (s: string): number =>
  (s.match(/proxy_http_version/gi) ?? []).length;

describe('expandForwardAuthSentinel', () => {
  it('expands the bare sentinel into the auth_request snippet (still {{AUTHELIA_PORT}}-templated)', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL)!;
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('{{AUTHELIA_PORT}}'); // installer Mustache-renders this later
    expect(out).not.toContain(AUTHELIA_FORWARD_AUTH_SENTINEL);
  });
  it('expands the prefix form and keeps the appended extras', () => {
    const out = expandForwardAuthSentinel(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\nclient_max_body_size 0;`)!;
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('client_max_body_size 0;');
  });
  it('expands a CRLF-terminated sentinel line exactly like the LF form (#2224)', () => {
    // A Windows/Local-authored template whose sentinel line ends in CRLF
    // must still expand its extras — the literal sentinel must never reach
    // the rendered .conf (nginx `[emerg] unknown directive`).
    const out = expandForwardAuthSentinel(
      `${AUTHELIA_FORWARD_AUTH_SENTINEL}\r\nclient_max_body_size 0;`,
    )!;
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('client_max_body_size 0;');
    expect(out).not.toContain(AUTHELIA_FORWARD_AUTH_SENTINEL);
    // identical to the LF form's output
    const lf = expandForwardAuthSentinel(
      `${AUTHELIA_FORWARD_AUTH_SENTINEL}\nclient_max_body_size 0;`,
    )!;
    expect(out).toBe(lf);
  });
  it('leaves a non-sentinel config untouched, and undefined as undefined', () => {
    expect(expandForwardAuthSentinel('proxy_set_header X 1;')).toBe('proxy_set_header X 1;');
    expect(expandForwardAuthSentinel(undefined)).toBeUndefined();
  });

  // #2143 — the acme-challenge bypass duplicates NPM's own on LE hosts.
  it('emits the acme-challenge bypass by default (LAN / cert-less hosts)', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL)!;
    expect(out).toContain('location /.well-known/acme-challenge/');
    expect(out).toContain('auth_request /authelia;');
  });
  it('omits the acme-challenge bypass for LE hosts (omitAcmeBypass) — no duplicate location', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL, { omitAcmeBypass: true })!;
    expect(out).not.toContain('acme-challenge');
    // the forward-auth core must still be present so the host stays gated
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('proxy_pass http://127.0.0.1:{{AUTHELIA_PORT}}/api/authz/auth-request;');
  });
  it('omits the bypass but keeps prefix-form extras', () => {
    const out = expandForwardAuthSentinel(
      `${AUTHELIA_FORWARD_AUTH_SENTINEL}\nclient_max_body_size 0;`,
      { omitAcmeBypass: true },
    )!;
    expect(out).not.toContain('acme-challenge');
    expect(out).toContain('client_max_body_size 0;');
  });
});

describe('renderForwardAuthAdvancedConfig — the no-Mustache (direct API) path', () => {
  it('expands the sentinel AND substitutes the port — no sentinel or placeholder survives', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091')!;
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    expect(out).not.toContain('{{AUTHELIA_PORT}}'); // would be an invalid nginx directive
    expect(out).not.toContain(AUTHELIA_FORWARD_AUTH_SENTINEL); // the #files-down bug
  });
  it('defaults the port to DEFAULT_AUTHELIA_PORT when none is given', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL)!;
    expect(out).toContain(`http://127.0.0.1:${DEFAULT_AUTHELIA_PORT}/api/authz/auth-request;`);
  });
  it('renders the prefix-form extras with the port substituted too', () => {
    const out = renderForwardAuthAdvancedConfig(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\nproxy_read_timeout 1h;`, '9091')!;
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    expect(out).toContain('proxy_read_timeout 1h;');
  });
  it('passes a non-forward-auth config through unchanged', () => {
    expect(renderForwardAuthAdvancedConfig('add_header X 1;', '9091')).toBe('add_header X 1;');
    expect(renderForwardAuthAdvancedConfig(undefined, '9091')).toBeUndefined();
  });

  // #2143 — on a public/internal (LE) host NPM supplies its own acme location,
  // so ours must be omitted or nginx crashes with `[emerg] duplicate location`.
  it('omits the acme-challenge bypass on LE hosts while keeping forward-auth', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091', { omitAcmeBypass: true })!;
    expect(out).not.toContain('acme-challenge');
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
  });
});

// #2205 — a websocket host gets a server-level `proxy_http_version 1.1;` from
// NPM; any copy in advanced_config duplicates it and nginx rejects the vhost
// (`[emerg] "proxy_http_version" directive is duplicate`).
describe('stripDuplicateProxyHttpVersion', () => {
  it('removes the directive (with leading whitespace) and leaves no blank line', () => {
    const input = 'proxy_read_timeout 1h;\n    proxy_http_version 1.1;\nproxy_buffering off;\n';
    const out = stripDuplicateProxyHttpVersion(input);
    expect(countHttpVersion(out)).toBe(0);
    expect(out).toBe('proxy_read_timeout 1h;\nproxy_buffering off;\n');
  });
  it('removes EVERY copy (SSE blocks sometimes repeat it)', () => {
    const input = 'proxy_http_version 1.1;\nproxy_set_header X 1;\nproxy_http_version 1.1;\n';
    expect(countHttpVersion(stripDuplicateProxyHttpVersion(input))).toBe(0);
  });
  it('is idempotent when the directive is absent', () => {
    const input = 'proxy_set_header Connection "upgrade";\n';
    expect(stripDuplicateProxyHttpVersion(input)).toBe(input);
  });
});

describe('websocket sanitize — exactly one proxy_http_version reaches nginx (#2205)', () => {
  // A realistic SSE-tuning advanced_config that sets proxy_http_version itself.
  const SSE_CONFIG = [
    'proxy_http_version 1.1;',
    'proxy_set_header Connection "";',
    'proxy_buffering off;',
    'proxy_read_timeout 3600s;',
  ].join('\n');

  it('websocket=true strips the redundant proxy_http_version from a plain advanced_config', () => {
    const out = expandForwardAuthSentinel(SSE_CONFIG, { websocket: true })!;
    // ServiceBay emits ZERO (NPM adds the one server-level copy for websocket
    // hosts), so the rendered vhost ends up with exactly one — not two.
    expect(countHttpVersion(out)).toBe(0);
    // the rest of the SSE tuning is preserved
    expect(out).toContain('proxy_read_timeout 3600s;');
    expect(out).toContain('proxy_buffering off;');
  });
  it('websocket unset leaves the advanced_config (and its proxy_http_version) untouched', () => {
    const out = expandForwardAuthSentinel(SSE_CONFIG)!;
    expect(countHttpVersion(out)).toBe(1);
    expect(out).toContain('proxy_http_version 1.1;');
  });
  it('websocket=true strips the directive from the sentinel prefix-form extras too', () => {
    const out = renderForwardAuthAdvancedConfig(
      `${AUTHELIA_FORWARD_AUTH_SENTINEL}\n${SSE_CONFIG}`,
      '9091',
      { omitAcmeBypass: true, websocket: true },
    )!;
    // forward-auth core still renders...
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    // ...and the duplicate directive from the extras is gone.
    expect(countHttpVersion(out)).toBe(0);
    expect(out).toContain('proxy_read_timeout 3600s;');
  });
  it('websocket=true on the forward-auth sentinel does not touch its own body (no proxy_http_version there)', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091', {
      omitAcmeBypass: true,
      websocket: true,
    })!;
    expect(countHttpVersion(out)).toBe(0);
    expect(out).toContain('auth_request /authelia;');
  });
});

// #2278 — the SB host injects the internal token on the *-from-authelia-session
// mint routes so a server-to-server caller through NPM crosses proxy.ts's CSRF
// gate (isInternalCall) and reaches the mint handler.
describe('buildAutheliaSessionMintLocation (#2278)', () => {
  const TOKEN = 'deadbeef'.repeat(8); // AUTH_SECRET-derived HMAC shape

  it('emits a location matching ONLY the two mint paths and injects the internal token', () => {
    const out = buildAutheliaSessionMintLocation(TOKEN, 'www.dopp.cloud');
    // The regex location anchors exactly the two mint routes.
    expect(out).toContain('location ~ ^/api/auth/(?:delegated-admin|token)-from-authelia-session$ {');
    // The internal token is stamped so the request passes proxy.ts:isInternalCall.
    expect(out).toContain(`proxy_set_header X-SB-Internal-Token ${TOKEN};`);
    // Both documented mint routes are covered by the anchored alternation.
    for (const p of AUTHELIA_SESSION_MINT_PATHS) {
      const re = new RegExp('^/api/auth/(?:delegated-admin|token)-from-authelia-session$');
      expect(re.test(p)).toBe(true);
    }
    // Unrelated paths must NOT match — the token is scoped to the mint routes.
    const re = new RegExp('^/api/auth/(?:delegated-admin|token)-from-authelia-session$');
    expect(re.test('/api/system/update')).toBe(false);
    expect(re.test('/api/auth/login')).toBe(false);
    expect(re.test('/api/auth/token-from-authelia-session/extra')).toBe(false);
  });

  it('runs forward-auth so the trusted Remote-User/Remote-Groups are injected (not client-supplied)', () => {
    const out = buildAutheliaSessionMintLocation(TOKEN, 'www.dopp.cloud');
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('auth_request_set $user $upstream_http_remote_user;');
    expect(out).toContain('auth_request_set $groups $upstream_http_remote_groups;');
    expect(out).toContain('proxy_set_header Remote-User $user;');
    expect(out).toContain('proxy_set_header Remote-Groups $groups;');
    // Reuses NPM's proxy.conf for the upstream proxy_pass — never a second one.
    expect(out).toContain('include conf.d/include/proxy.conf;');
    expect(out).not.toContain('proxy_pass $forward_scheme');
  });

  it('probes the wildcard-covered www host (apex is Authelia default-deny — no identity there)', () => {
    const out = buildAutheliaSessionMintLocation(TOKEN, 'www.dopp.cloud');
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    // X-Original-URL points at the www host, NOT the request's own (apex) host.
    expect(out).toContain('proxy_set_header X-Original-URL https://www.dopp.cloud$request_uri;');
  });

  it('falls back to the request host when no www host is given (host already under the wildcard rule)', () => {
    const out = buildAutheliaSessionMintLocation(TOKEN, undefined);
    expect(out).toContain('proxy_set_header X-Original-URL $scheme://$http_host$request_uri;');
  });

  it('substitutes the given Authelia port (defaults to DEFAULT_AUTHELIA_PORT)', () => {
    expect(buildAutheliaSessionMintLocation(TOKEN, 'www.dopp.cloud', '9099')).toContain(
      'proxy_pass http://127.0.0.1:9099/api/authz/auth-request;',
    );
    expect(buildAutheliaSessionMintLocation(TOKEN, 'www.dopp.cloud')).toContain(
      `proxy_pass http://127.0.0.1:${DEFAULT_AUTHELIA_PORT}/api/authz/auth-request;`,
    );
  });
});
