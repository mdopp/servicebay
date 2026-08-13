import { describe, it, expect } from 'vitest';
import {
  mergeCredentials,
  resolveCredentialUrl,
  isHttpUrl,
  buildBitwardenCsv,
  credentialKey,
  credentialReceipt,
  dropDeliveredPasswords,
  isCredentialSecured,
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
 * #2560 — the hand-over state. There is no marker beside the password:
 * "handed over" IS "we no longer hold the secret", which is what makes the
 * inconsistent pair unrepresentable. These tests pin that down.
 */
describe('credential hand-over state (#2560)', () => {
  const unsecured = (service: string, template?: string): Credential => cred(service, template);
  const secured = (service: string, template?: string): Credential => ({
    ...cred(service, template), password: '',
  });

  it('derives the state from the password alone', () => {
    expect(isCredentialSecured(unsecured('lldap'))).toBe(false);
    expect(isCredentialSecured({ password: '' })).toBe(true);
    expect(isCredentialSecured({ password: 'still-here' })).toBe(false);
  });

  it('summarises how many entries ServiceBay still holds the secret for', () => {
    const s = summarizeCredentialSecurity([secured('lldap'), secured('npm'), unsecured('immich')]);
    expect(s).toEqual({ total: 3, secured: 2, unsecured: 1 });
  });

  it('summarises an empty manifest', () => {
    expect(summarizeCredentialSecurity([])).toEqual({ total: 0, secured: 0, unsecured: 0 });
  });

  it('excludes handed-over entries from the Bitwarden CSV', () => {
    const csv = buildBitwardenCsv([secured('lldap'), unsecured('immich')]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2); // header + the one pending row
    expect(csv).toContain('immich');
    expect(csv).not.toContain('lldap');
  });

  it('a re-install of a handed-over template resets it to pending', () => {
    // mergeCredentials replaces the deployed template's entries wholesale,
    // so the fresh secret is pending again — ServiceBay cannot know the
    // operator's file still matches.
    const existing = [secured('lldap', 'auth')];
    const fresh = [{ ...cred('lldap', 'auth'), password: 'ROTATED' }];
    const merged = mergeCredentials(existing, fresh, ['auth']);
    expect(merged).toHaveLength(1);
    expect(isCredentialSecured(merged[0])).toBe(false);
    expect(merged[0].password).toBe('ROTATED');
  });

  it('does not un-hand-over entries owned by templates this install did not touch', () => {
    const existing = [secured('lldap', 'auth')];
    const merged = mergeCredentials(existing, [cred('immich', 'immich')], ['immich']);
    expect(isCredentialSecured(merged.find(c => c.service === 'lldap')!)).toBe(true);
  });
});

describe('dropping only what a hand-over delivered (#2560)', () => {
  it('keys an entry by template + service + username', () => {
    expect(credentialKey(cred('immich', 'immich'))).toBe('immich::immich::admin');
    // Two accounts on the same service must not collapse into one entry.
    expect(credentialKey({ ...cred('immich', 'immich'), username: 'service' }))
      .not.toBe(credentialKey(cred('immich', 'immich')));
  });

  it('drops the password of ONLY the delivered entries', () => {
    const creds = [cred('immich', 'immich'), cred('lldap', 'auth')];
    const next = dropDeliveredPasswords(creds, new Set([credentialKey(creds[1])]));

    expect(next[0].password).toBe('secret');
    expect(next[1].password).toBe('');
    // The pointer survives — Settings still says *what* exists.
    expect(next[1].service).toBe('lldap');
    expect(next[1].username).toBe('admin');
  });

  it('an unknown key drops nothing — no accidental blanket wipe', () => {
    const creds = [cred('immich', 'immich')];
    const next = dropDeliveredPasswords(creds, new Set(['other::x::y']));
    expect(next[0].password).toBe('secret');
    expect(summarizeCredentialSecurity(next).unsecured).toBe(1);
  });
});

describe('credentialReceipt (#2560)', () => {
  it('is stable for identical content', () => {
    expect(credentialReceipt('a,b,c\n')).toBe(credentialReceipt('a,b,c\n'));
  });

  it('changes when a single byte changes', () => {
    expect(credentialReceipt('a,b,c\n')).not.toBe(credentialReceipt('a,b,d\n'));
  });

  it('changes when the file is truncated — the failure mode it exists for', () => {
    const csv = buildBitwardenCsv([cred('immich', 'immich'), cred('lldap', 'auth')]);
    expect(credentialReceipt(csv.slice(0, -20))).not.toBe(credentialReceipt(csv));
  });

  it('leads with the exact byte length', () => {
    expect(credentialReceipt('hello')).toMatch(/^5-[0-9a-f]{16}$/);
    // Multi-byte characters count as bytes, not code points.
    expect(credentialReceipt('ä')).toMatch(/^2-/);
  });
});
