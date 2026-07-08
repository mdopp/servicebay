import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { rewriteAutheliaConfig } from './autheliaRewrite';

/**
 * Structural view of the parsed Authelia config the tests reach into.
 * Fields are non-optional because every test drives a well-formed
 * rewritten doc and asserts the leaf directly; the `load` cast is the
 * single unsafe boundary.
 */
interface ParsedConfig {
  session: {
    cookies: {
      name?: string;
      domain?: string;
      authelia_url?: string;
      default_redirection_url?: string;
    }[];
  };
  access_control: {
    default_policy?: string;
    rules: { domain?: string | string[]; policy?: string }[];
  };
  identity_providers: {
    oidc: {
      clients: { client_id?: string; client_secret?: string; redirect_uris: string[] }[];
    };
  };
}

const load = (s: string): ParsedConfig => yaml.load(s) as unknown as ParsedConfig;

const LAN = 'home.arpa';
const PUB = 'dopp.cloud';

/**
 * A representative install-time LAN Authelia `configuration.yml`:
 * a session cookie bound to the lan root, one access_control rule with a
 * list of lan domains, and two OIDC clients with redirect_uris (one of
 * which mixes a lan callback with a third-party one).
 */
const LAN_CONFIG = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
      authelia_url: https://auth.home.arpa
      default_redirection_url: https://home.arpa
access_control:
  default_policy: deny
  rules:
    - domain:
        - home.arpa
        - immich.home.arpa
      policy: one_factor
    - domain: 'files.home.arpa'
      policy: two_factor
identity_providers:
  oidc:
    clients:
      - client_id: immich
        redirect_uris:
          - https://immich.home.arpa/auth/login
          - https://third-party.example.com/callback
      - client_id: vault
        redirect_uris:
          - https://vault.home.arpa/oidc/callback
`;

function rewrite(config: string) {
  return rewriteAutheliaConfig(config, LAN, PUB);
}

describe('rewriteAutheliaConfig — session cookie (hard cutover)', () => {
  it('flips the cookie domain from the lan root to the public domain', () => {
    const { yaml: out, changes } = rewrite(LAN_CONFIG);
    const doc = load(out);
    expect(doc.session.cookies[0].domain).toBe(PUB);
    expect(changes.cookieDomain).toEqual({ from: 'home.arpa', to: PUB });
  });

  it('rewrites authelia_url onto the public auth subdomain', () => {
    const { yaml: out, changes } = rewrite(LAN_CONFIG);
    const doc = load(out);
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud/');
    expect(changes.cookieAutheliaUrl.from).toBe('https://auth.home.arpa');
    expect(changes.cookieAutheliaUrl.to).toBe('https://auth.dopp.cloud/');
  });

  it('preserves a non-default PORT on the existing authelia_url', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
      authelia_url: https://auth.home.arpa:9091
`;
    const doc = load(rewrite(cfg).yaml);
    // host twinned, port survives (a mis-parse here corrupts the auth endpoint)
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud:9091/');
  });

  it('preserves a non-default PATH on the existing authelia_url', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
      authelia_url: https://auth.home.arpa/authenticate
`;
    const doc = load(rewrite(cfg).yaml);
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud/authenticate');
  });

  it('twins the sub-domain of a non-auth authelia_url host, not hard-coding "auth"', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
      authelia_url: https://sso.home.arpa
`;
    const doc = load(rewrite(cfg).yaml);
    expect(doc.session.cookies[0].authelia_url).toBe('https://sso.dopp.cloud/');
  });

  it('falls back to https://auth.<publicDomain> when authelia_url is missing', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
`;
    const { yaml: out, changes } = rewrite(cfg);
    const doc = load(out);
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud');
    expect(changes.cookieAutheliaUrl.from).toBeNull();
  });

  it('falls back to https://auth.<publicDomain> when authelia_url is malformed', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: home.arpa
      authelia_url: 'not a url'
`;
    const doc = load(rewrite(cfg).yaml);
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud');
  });

  it('leaves an already-public authelia_url untouched (idempotency)', () => {
    const cfg = `
session:
  cookies:
    - name: authelia_session
      domain: dopp.cloud
      authelia_url: https://auth.dopp.cloud
`;
    const doc = load(rewrite(cfg).yaml);
    expect(doc.session.cookies[0].authelia_url).toBe('https://auth.dopp.cloud');
  });

  it('leaves config with no session cookies untouched', () => {
    const cfg = `theme: light\n`;
    const { changes } = rewrite(cfg);
    expect(changes.cookieDomain.from).toBeNull();
  });
});

describe('rewriteAutheliaConfig — access_control rules (additive twin)', () => {
  it('adds public-domain twins WITHOUT dropping the lan entries (list form)', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    const listRule = doc.access_control.rules[0].domain;
    // both lan originals preserved, both public twins appended
    expect(listRule).toEqual([
      'home.arpa',
      'dopp.cloud',
      'immich.home.arpa',
      'immich.dopp.cloud',
    ]);
  });

  it('twins a single-string domain into [lan, public]', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    expect(doc.access_control.rules[1].domain).toEqual([
      'files.home.arpa',
      'files.dopp.cloud',
    ]);
  });

  it('records per-rule before/after in changes', () => {
    const { changes } = rewrite(LAN_CONFIG);
    expect(changes.accessControlRuleDomains).toHaveLength(2);
    expect(changes.accessControlRuleDomains[0].from).toEqual([
      'home.arpa',
      'immich.home.arpa',
    ]);
    expect(changes.accessControlRuleDomains[0].to).toEqual([
      'home.arpa',
      'dopp.cloud',
      'immich.home.arpa',
      'immich.dopp.cloud',
    ]);
  });

  it('leaves a non-lan domain rule unchanged and does not record it', () => {
    const cfg = `
access_control:
  rules:
    - domain: '*.example.com'
      policy: one_factor
`;
    const { yaml: out, changes } = rewrite(cfg);
    const doc = load(out);
    expect(doc.access_control.rules[0].domain).toBe('*.example.com');
    expect(changes.accessControlRuleDomains).toHaveLength(0);
  });

  it('is idempotent — a second run adds no further twins', () => {
    const once = rewrite(LAN_CONFIG).yaml;
    const twice = rewrite(once);
    const doc = load(twice.yaml);
    expect(doc.access_control.rules[0].domain).toEqual([
      'home.arpa',
      'dopp.cloud',
      'immich.home.arpa',
      'immich.dopp.cloud',
    ]);
    // no domain rules re-recorded as changed on the migrated config
    expect(twice.changes.accessControlRuleDomains).toHaveLength(0);
  });
});

describe('rewriteAutheliaConfig — OIDC redirect_uris (additive, deduped)', () => {
  it('appends public-domain twins and preserves the lan + third-party uris', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    const immich = doc.identity_providers.oidc.clients[0];
    expect(immich.redirect_uris).toEqual([
      'https://immich.home.arpa/auth/login',
      'https://third-party.example.com/callback',
      'https://immich.dopp.cloud/auth/login',
    ]);
  });

  it('preserves the callback PATH when twinning a redirect_uri', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    const vault = doc.identity_providers.oidc.clients[1];
    expect(vault.redirect_uris).toContain('https://vault.dopp.cloud/oidc/callback');
  });

  it('does NOT twin a third-party (non-lan) callback', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    const immich = doc.identity_providers.oidc.clients[0];
    // match on the exact host, not a substring, so the assertion can't be
    // satisfied by an attacker-shaped URL like https://example.com.evil/ (CodeQL
    // js/incomplete-url-substring-sanitization)
    expect(
      immich.redirect_uris.filter(
        (u: string) => new URL(u).hostname === 'third-party.example.com',
      ),
    ).toEqual(['https://third-party.example.com/callback']);
  });

  it('records the additions per client, keyed by client_id', () => {
    const { changes } = rewrite(LAN_CONFIG);
    expect(changes.oidcRedirectUriAdditions).toEqual([
      { clientId: 'immich', added: ['https://immich.dopp.cloud/auth/login'] },
      { clientId: 'vault', added: ['https://vault.dopp.cloud/oidc/callback'] },
    ]);
  });

  it('dedups — does not re-append a twin that is already present (idempotency)', () => {
    const cfg = `
identity_providers:
  oidc:
    clients:
      - client_id: immich
        redirect_uris:
          - https://immich.home.arpa/auth/login
          - https://immich.dopp.cloud/auth/login
`;
    const { yaml: out, changes } = rewrite(cfg);
    const doc = load(out);
    const uris = doc.identity_providers.oidc.clients[0].redirect_uris;
    expect(uris).toHaveLength(2);
    expect(uris.filter((u: string) => u === 'https://immich.dopp.cloud/auth/login'))
      .toHaveLength(1);
    expect(changes.oidcRedirectUriAdditions).toHaveLength(0);
  });

  it('running the whole rewrite twice adds no new redirect twins', () => {
    const once = rewrite(LAN_CONFIG).yaml;
    const twice = rewrite(once);
    expect(twice.changes.oidcRedirectUriAdditions).toHaveLength(0);
    const doc = load(twice.yaml);
    expect(doc.identity_providers.oidc.clients[0].redirect_uris).toEqual([
      'https://immich.home.arpa/auth/login',
      'https://third-party.example.com/callback',
      'https://immich.dopp.cloud/auth/login',
    ]);
  });
});

describe('rewriteAutheliaConfig — round-trip & robustness', () => {
  it('round-trips: every non-twinned field survives the rewrite unchanged', () => {
    const doc = load(rewrite(LAN_CONFIG).yaml);
    expect(doc.session.cookies[0].name).toBe('authelia_session');
    expect(doc.session.cookies[0].default_redirection_url).toBe('https://home.arpa');
    expect(doc.access_control.default_policy).toBe('deny');
    expect(doc.access_control.rules[0].policy).toBe('one_factor');
    expect(doc.identity_providers.oidc.clients[0].client_id).toBe('immich');
  });

  it('preserves a special-char / quoted secret value verbatim', () => {
    const cfg = `
identity_providers:
  oidc:
    clients:
      - client_id: immich
        client_secret: '$argon2id$v=19$m=65536,t=3,p=4$abc: def#ghi'
        redirect_uris:
          - https://immich.home.arpa/auth/login
`;
    const doc = load(rewrite(cfg).yaml);
    expect(doc.identity_providers.oidc.clients[0].client_secret).toBe(
      '$argon2id$v=19$m=65536,t=3,p=4$abc: def#ghi',
    );
  });

  it('returns the input unchanged for empty / non-object yaml', () => {
    expect(rewrite('').yaml).toBe('');
    expect(rewrite('   ').yaml).toBe('   ');
    const scalar = rewrite('just a string');
    expect(scalar.yaml).toBe('just a string');
    expect(scalar.changes.accessControlRuleDomains).toHaveLength(0);
  });

  it('emits parseable yaml (no dump crash on the migrated doc)', () => {
    const out = rewrite(LAN_CONFIG).yaml;
    expect(() => yaml.load(out)).not.toThrow();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
