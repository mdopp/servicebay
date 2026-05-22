import { describe, it, expect } from 'vitest';
import { mergeCredentials, type Credential } from './credentialsManifest';

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
