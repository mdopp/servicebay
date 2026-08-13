import { describe, it, expect } from 'vitest';
import {
  mergeCredentials,
  resolveCredentialUrl,
  isHttpUrl,
  buildBitwardenCsv,
  credentialKey,
  isCredentialSecured,
  markCredentialsSecured,
  markCredentialsSecuredByKey,
  summarizeCredentialSecurity,
  type Credential,
  type CredentialUrlContext,
} from './credentialsManifest';

const cred = (service: string, template?: string): Credential => ({
  service,
  url: `https://${service}.example`,
  username: 'admin',
  password: 'secret',
  importance: 'critical',
  template,
});

describe('mergeCredentials', () => {
  it('returns the fresh manifest verbatim on a clean install (no existing entries)', () => {
    const fresh = [cred('lldap', 'auth'), cred('npm', 'nginx')];
    expect(mergeCredentials([], fresh, ['auth', 'nginx'])).toEqual(fresh);
  });

  it('replaces entries owned by a re-installed template', () => {
    const existing = [{ ...cred('lldap', 'auth'), password: 'OLD' }];
    const fresh = [{ ...cred('lldap', 'auth'), password: 'NEW' }];
    const merged = mergeCredentials(existing, fresh, ['auth']);
    expect(merged).toHaveLength(1);
    expect(merged[0].password).toBe('NEW');
  });

  it('preserves entries owned by templates not in this install (feature-only add)', () => {
    const existing = [cred('lldap', 'auth'), cred('npm', 'nginx')];
    const fresh = [cred('immich', 'immich')];
    const merged = mergeCredentials(existing, fresh, ['immich']);
    expect(merged.map(c => c.service).sort()).toEqual(['immich', 'lldap', 'npm']);
  });

  it('keeps legacy untagged entries (no template field) — never auto-dropped', () => {
    const existing = [cred('legacy-thing', undefined)];
    const fresh = [cred('immich', 'immich')];
    const merged = mergeCredentials(existing, fresh, ['immich']);
    expect(merged.map(c => c.service).sort()).toEqual(['immich', 'legacy-thing']);
  });

  it('drops a template\'s old entry even when this run produced none for it (uninstall-via-reinstall)', () => {
    const existing = [cred('lldap', 'auth'), cred('immich', 'immich')];
    // 'immich' is re-installed but emits no credentials this run
    const merged = mergeCredentials(existing, [cred('lldap', 'auth')], ['auth', 'immich']);
    expect(merged.map(c => c.service)).toEqual(['lldap']);
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('http://localhost:81')).toBe(true);
    expect(isHttpUrl('https://ldap.dopp.cloud/user/mdopp79')).toBe(true);
  });
  it('rejects non-URL hints and other schemes', () => {
    for (const v of ['env: LLDAP_JWT_SECRET', '\\\\localhost\\data', '(bearer token)', 'ssh://dev@localhost:2222', '<server-ip>', '', undefined]) {
      expect(isHttpUrl(v as string | undefined)).toBe(false);
    }
  });
});

describe('resolveCredentialUrl', () => {
  const ctx: CredentialUrlContext = {
    publicDomain: 'dopp.cloud',
    hosts: [
      { service: 'nginx', domain: 'nginx.dopp.cloud' },
      { service: 'auth', domain: 'ldap.dopp.cloud' },
      { service: 'adguard', domain: 'dns.dopp.cloud' },
    ],
  };
  const c = (url: string, service: string, template?: string): Credential => ({
    service, url, username: 'admin', password: 'x', importance: 'critical', template,
  });

  it('rewrites a loopback URL to the public subdomain via template match', () => {
    expect(resolveCredentialUrl(c('http://localhost:81', 'Nginx Proxy Manager', 'nginx'), ctx))
      .toBe('https://nginx.dopp.cloud');
  });

  it('matches by service-name substring when template is absent', () => {
    expect(resolveCredentialUrl(c('http://localhost:8083', 'AdGuard Home'), ctx))
      .toBe('https://dns.dopp.cloud');
  });

  it('preserves path/query/hash when rewriting', () => {
    expect(resolveCredentialUrl(c('http://localhost:17170/admin?x=1#y', 'LLDAP', 'auth'), ctx))
      .toBe('https://ldap.dopp.cloud/admin?x=1#y');
  });

  it('leaves an already-public http(s) URL untouched', () => {
    expect(resolveCredentialUrl(c('https://ldap.dopp.cloud/user/mdopp79', 'LLDAP user', 'auth'), ctx))
      .toBe('https://ldap.dopp.cloud/user/mdopp79');
  });

  it('passes non-URL values through unchanged', () => {
    expect(resolveCredentialUrl(c('env: LLDAP_JWT_SECRET', 'LLDAP JWT', 'auth'), ctx))
      .toBe('env: LLDAP_JWT_SECRET');
    expect(resolveCredentialUrl(c('ssh://dev@localhost:2222', 'Claude Dev', 'claude-dev'), ctx))
      .toBe('ssh://dev@localhost:2222');
  });

  it('returns the original loopback URL when no proxy host matches', () => {
    expect(resolveCredentialUrl(c('http://localhost:8096', 'Jellyfin', 'media'), ctx))
      .toBe('http://localhost:8096');
  });
});

describe('buildBitwardenCsv login_uri', () => {
  const ctx: CredentialUrlContext = {
    hosts: [{ service: 'nginx', domain: 'nginx.dopp.cloud' }],
  };
  const c = (url: string, template?: string): Credential => ({
    service: 'Nginx Proxy Manager', url, username: 'admin', password: 'x', importance: 'critical', template,
  });

  it('writes the resolved public URL into login_uri', () => {
    const csv = buildBitwardenCsv([c('http://localhost:81', 'nginx')], ctx);
    expect(csv).toContain('"https://nginx.dopp.cloud"');
    expect(csv).not.toContain('localhost:81');
  });

  it('leaves login_uri empty for non-URL values', () => {
    const csv = buildBitwardenCsv([{ ...c('env: SECRET', 'auth'), service: 'JWT' }], ctx);
    const line = csv.trim().split('\n')[1];
    // login_uri is the 8th column — empty for a non-URL value
    expect(line.split(',')[7]).toBe('""');
  });
});

/**
 * #2519 — the Vaultwarden hand-off state. "Secured" means the secret lives
 * in the operator's vault and ServiceBay dropped its copy; the two must
 * never be true at once, which is what these tests pin down.
 */
describe('credential security state (#2519)', () => {
  const unsecured = (service: string, template?: string): Credential => cred(service, template);
  const secured = (service: string, at: string, template?: string): Credential => ({
    ...cred(service, template), password: '', securedAt: at,
  });

  it('treats a missing or empty securedAt as not secured', () => {
    expect(isCredentialSecured(unsecured('lldap'))).toBe(false);
    expect(isCredentialSecured({ securedAt: '' })).toBe(false);
    expect(isCredentialSecured({ securedAt: '2026-08-13T00:00:00.000Z' })).toBe(true);
  });

  it('summarises how many entries ServiceBay still holds the secret for', () => {
    const s = summarizeCredentialSecurity([
      secured('lldap', '2026-08-10T00:00:00.000Z'),
      secured('npm', '2026-08-12T00:00:00.000Z'),
      unsecured('immich'),
    ]);
    expect(s).toEqual({
      total: 3,
      secured: 2,
      unsecured: 1,
      lastSecuredAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('summarises an empty manifest without a last-sync timestamp', () => {
    expect(summarizeCredentialSecurity([])).toEqual({
      total: 0, secured: 0, unsecured: 0, lastSecuredAt: null,
    });
  });

  it('drops the password in the same step that marks an entry secured', () => {
    const at = '2026-08-13T12:00:00.000Z';
    const out = markCredentialsSecured([unsecured('lldap'), unsecured('npm')], at);
    expect(out.every(c => c.password === '')).toBe(true);
    expect(out.every(c => c.securedAt === at)).toBe(true);
    // The pointer survives — Settings still says *what* exists.
    expect(out.map(c => c.service)).toEqual(['lldap', 'npm']);
    expect(out[0].username).toBe('admin');
  });

  it('leaves an already-secured entry (and its original timestamp) untouched', () => {
    const first = '2026-08-01T00:00:00.000Z';
    const out = markCredentialsSecured([secured('lldap', first)], '2026-08-13T12:00:00.000Z');
    expect(out[0].securedAt).toBe(first);
  });

  it('never leaves a secured entry that still carries a secret', () => {
    const out = markCredentialsSecured(
      [unsecured('lldap'), secured('npm', '2026-08-01T00:00:00.000Z')],
      '2026-08-13T12:00:00.000Z',
    );
    expect(out.filter(c => isCredentialSecured(c)).every(c => c.password === '')).toBe(true);
  });

  it('excludes secured entries from the Bitwarden CSV', () => {
    const csv = buildBitwardenCsv([
      secured('lldap', '2026-08-01T00:00:00.000Z'),
      unsecured('immich'),
    ]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2); // header + the one unsecured row
    expect(csv).toContain('immich');
    expect(csv).not.toContain('lldap');
  });

  it('a re-install of a secured template resets it to not-yet-secured', () => {
    // mergeCredentials replaces the deployed template's entries wholesale,
    // so `securedAt` goes with them — the fresh secret is unsecured again.
    const existing = [secured('lldap', '2026-08-01T00:00:00.000Z', 'auth')];
    const fresh = [{ ...cred('lldap', 'auth'), password: 'ROTATED' }];
    const merged = mergeCredentials(existing, fresh, ['auth']);
    expect(merged).toHaveLength(1);
    expect(isCredentialSecured(merged[0])).toBe(false);
    expect(merged[0].password).toBe('ROTATED');
  });

  it('does not un-secure entries owned by templates this install did not touch', () => {
    const existing = [secured('lldap', '2026-08-01T00:00:00.000Z', 'auth')];
    const merged = mergeCredentials(existing, [cred('immich', 'immich')], ['immich']);
    expect(isCredentialSecured(merged.find(c => c.service === 'lldap')!)).toBe(true);
  });
});

describe('per-entry securing (#2519 automated push)', () => {
  it('keys an entry by template + service + username', () => {
    expect(credentialKey(cred('immich', 'immich'))).toBe('immich::immich::admin');
    // Two accounts on the same service must not collapse into one item.
    expect(credentialKey({ ...cred('immich', 'immich'), username: 'service' }))
      .not.toBe(credentialKey(cred('immich', 'immich')));
  });

  it('secures ONLY the confirmed entries and drops just their passwords', () => {
    const creds = [cred('immich', 'immich'), cred('lldap', 'auth')];
    const at = '2026-08-13T12:00:00.000Z';
    const next = markCredentialsSecuredByKey(creds, new Set([credentialKey(creds[1])]), at);

    expect(next[0].password).toBe('secret');
    expect(next[0].securedAt).toBeUndefined();
    expect(next[1].password).toBe('');
    expect(next[1].securedAt).toBe(at);
  });

  it('never resurrects a password and never restamps an already-secured entry', () => {
    const already: Credential = { ...cred('lldap', 'auth'), password: '', securedAt: '2026-08-01T00:00:00.000Z' };
    const next = markCredentialsSecuredByKey([already], new Set([credentialKey(already)]), '2026-08-13T12:00:00.000Z');
    expect(next[0].securedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(next[0].password).toBe('');
  });

  it('an unknown key secures nothing — no accidental blanket marking', () => {
    const creds = [cred('immich', 'immich')];
    const next = markCredentialsSecuredByKey(creds, new Set(['other::x::y']), '2026-08-13T12:00:00.000Z');
    expect(next[0].password).toBe('secret');
    expect(summarizeCredentialSecurity(next).unsecured).toBe(1);
  });
});
