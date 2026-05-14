import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { rewriteAutheliaConfig } from '@/lib/reverseProxy/autheliaRewrite';

/**
 * Pure-yaml tests for the Authelia config rewrite step of the
 * LAN→Public migration (#265). Exercises:
 *   - hard cutover of session.cookies[0].domain + authelia_url
 *   - additive twin of access_control rule domains (string and list)
 *   - additive twin of OIDC client redirect_uris
 *   - idempotence: a second rewrite on the output is a no-op
 *
 * Sample yaml mirrors the structure templated by
 * `templates/auth/configuration.yml.mustache` after install in lan mode
 * (i.e. PUBLIC_DOMAIN was rendered with the lan root).
 */

const LAN_ROOT = 'home.arpa';
const PUBLIC_DOMAIN = 'dopp.cloud';

const SAMPLE_LAN_CONFIG = `
session:
  secret: 's3cret'
  cookies:
    - domain: 'home.arpa'
      authelia_url: 'https://auth.home.arpa'

access_control:
  default_policy: deny
  rules:
    - domain: 'auth.home.arpa'
      policy: bypass
    - domain:
        - 'admin.home.arpa'
        - 'nginx.home.arpa'
      policy: two_factor
      subject:
        - 'group:admins'
    - domain: '*.home.arpa'
      policy: one_factor
      subject:
        - 'group:family'
        - 'group:admins'

identity_providers:
  oidc:
    hmac_secret: 'h'
    clients:
      - client_id: 'servicebay'
        client_name: 'ServiceBay'
        client_secret: 'p'
        redirect_uris:
          - 'https://admin.home.arpa/api/auth/oidc/callback'
        scopes:
          - 'openid'
      - client_id: 'vaultwarden'
        client_name: 'Vaultwarden'
        client_secret: 'p'
        redirect_uris:
          - 'https://vault.home.arpa/identity/connect/oidc-signin'
          - 'app.bitwarden:/oauth-callback'
        scopes:
          - 'openid'
`;

describe('rewriteAutheliaConfig', () => {
  it('flips the cookie domain + authelia_url to the public root', () => {
    const out = rewriteAutheliaConfig(SAMPLE_LAN_CONFIG, LAN_ROOT, PUBLIC_DOMAIN);
    const parsed = yaml.load(out.yaml) as { session: { cookies: { domain: string; authelia_url: string }[] } };
    expect(parsed.session.cookies[0].domain).toBe(PUBLIC_DOMAIN);
    // URL.toString() always emits a trailing slash for host-only URLs;
    // this is semantically equivalent for Authelia's authelia_url, so
    // accept either form.
    expect(parsed.session.cookies[0].authelia_url).toMatch(/^https:\/\/auth\.dopp\.cloud\/?$/);
    expect(out.changes.cookieDomain).toEqual({ from: 'home.arpa', to: PUBLIC_DOMAIN });
    expect(out.changes.cookieAutheliaUrl.from).toBe('https://auth.home.arpa');
    expect(out.changes.cookieAutheliaUrl.to).toMatch(/^https:\/\/auth\.dopp\.cloud\/?$/);
  });

  it('twins string-form access_control rule domains into a list', () => {
    const out = rewriteAutheliaConfig(SAMPLE_LAN_CONFIG, LAN_ROOT, PUBLIC_DOMAIN);
    const parsed = yaml.load(out.yaml) as { access_control: { rules: { domain: unknown }[] } };

    // 'auth.home.arpa' (string) → ['auth.home.arpa', 'auth.dopp.cloud']
    expect(parsed.access_control.rules[0].domain).toEqual([
      'auth.home.arpa',
      'auth.dopp.cloud',
    ]);

    // '*.home.arpa' (string) → ['*.home.arpa', '*.dopp.cloud']
    expect(parsed.access_control.rules[2].domain).toEqual([
      '*.home.arpa',
      '*.dopp.cloud',
    ]);
  });

  it('twins list-form access_control rule domains, preserving order', () => {
    const out = rewriteAutheliaConfig(SAMPLE_LAN_CONFIG, LAN_ROOT, PUBLIC_DOMAIN);
    const parsed = yaml.load(out.yaml) as { access_control: { rules: { domain: unknown }[] } };

    expect(parsed.access_control.rules[1].domain).toEqual([
      'admin.home.arpa',
      'admin.dopp.cloud',
      'nginx.home.arpa',
      'nginx.dopp.cloud',
    ]);
  });

  it('appends public-domain twins to OIDC redirect_uris without disturbing third-party URIs', () => {
    const out = rewriteAutheliaConfig(SAMPLE_LAN_CONFIG, LAN_ROOT, PUBLIC_DOMAIN);
    const parsed = yaml.load(out.yaml) as { identity_providers: { oidc: { clients: { client_id: string; redirect_uris: string[] }[] } } };
    const sb = parsed.identity_providers.oidc.clients.find(c => c.client_id === 'servicebay')!;
    const vw = parsed.identity_providers.oidc.clients.find(c => c.client_id === 'vaultwarden')!;

    expect(sb.redirect_uris).toEqual([
      'https://admin.home.arpa/api/auth/oidc/callback',
      'https://admin.dopp.cloud/api/auth/oidc/callback',
    ]);

    // Custom-scheme deep links are left alone.
    expect(vw.redirect_uris).toEqual([
      'https://vault.home.arpa/identity/connect/oidc-signin',
      'app.bitwarden:/oauth-callback',
      'https://vault.dopp.cloud/identity/connect/oidc-signin',
    ]);
  });

  it('is idempotent — a second rewrite on the output yields the same yaml', () => {
    const first = rewriteAutheliaConfig(SAMPLE_LAN_CONFIG, LAN_ROOT, PUBLIC_DOMAIN);
    const second = rewriteAutheliaConfig(first.yaml, LAN_ROOT, PUBLIC_DOMAIN);
    expect(second.yaml).toBe(first.yaml);
    // Cookie change re-reports because the editor doesn't know the prior value
    // was already migrated; the additive sections must report empty deltas.
    expect(second.changes.accessControlRuleDomains).toEqual([]);
    expect(second.changes.oidcRedirectUriAdditions).toEqual([]);
  });

  it('preserves the original yaml when there is nothing to migrate', () => {
    const inert = `
unrelated:
  key: 'value'
`;
    const out = rewriteAutheliaConfig(inert, LAN_ROOT, PUBLIC_DOMAIN);
    // No session block → no cookie change; no rules / clients → no twin work.
    expect(out.changes.cookieDomain).toEqual({ from: null, to: PUBLIC_DOMAIN });
    expect(out.changes.accessControlRuleDomains).toEqual([]);
    expect(out.changes.oidcRedirectUriAdditions).toEqual([]);
  });
});
