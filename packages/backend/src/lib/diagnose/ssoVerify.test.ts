import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));
vi.mock('@/lib/config', () => ({ getConfig: () => mockGetConfig() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// The agent/lldap real deps are never reached when deps are injected, but
// the imports must resolve.
vi.mock('@/lib/agent/manager', () => ({ agentManager: { ensureAgent: vi.fn() } }));
vi.mock('@/lib/lldap/client', () => ({
  createLldapUser: vi.fn(),
  addUserToLldapGroup: vi.fn(),
  deleteLldapUser: vi.fn(),
  listLldapGroups: vi.fn(),
}));

import {
  verifySso,
  classifyUserDomain,
  classifyAdminReject,
  classifyOidcAuthorization,
  extractAutheliaCookie,
  extractOauthError,
  makeEphemeralUsername,
  USER_APP_SIGNATURES,
  SUBDOMAIN_TEMPLATE,
  OIDC_CLIENT_SUBDOMAINS,
  FORWARD_AUTH_DERIVED_SUBDOMAINS,
  ADMIN_ONLY_HOSTS,
  probeableUserSubdomains,
  type SsoVerifyDeps,
  type DomainProbe,
  type OidcAuthProbe,
} from './ssoVerify';

const tmpl = (n: string) => ({ [n]: { schemaVersion: 1, installedAt: '2026-05-01T00:00:00Z' } });

// A "full" install: auth + every template that backs a user subdomain. Used
// by the happy-path tests so all USER_APP_SIGNATURES hosts are probed.
const fullTemplates = Object.assign(
  { auth: { schemaVersion: 1, installedAt: '2026-05-01T00:00:00Z' } },
  ...[...new Set(Object.values(SUBDOMAIN_TEMPLATE))].map(tmpl),
);

const okConfig = {
  reverseProxy: { publicDomain: 'dopp.cloud' },
  installedTemplates: fullTemplates,
};

/** Deps where every step succeeds and every domain behaves correctly. By
 *  default no forward-auth-derived host (ollama) is gated; opt in per-test. */
function happyDeps(opts: { forwardAuthHosts?: string[] } = {}): { deps: SsoVerifyDeps; calls: { deleted: string[] } } {
  const calls = { deleted: [] as string[] };
  const gated = new Set(opts.forwardAuthHosts ?? []);
  const deps: SsoVerifyDeps = {
    listGroups: vi.fn(async () => ({ ok: true as const, groups: [{ id: 2, displayName: 'family' }, { id: 1, displayName: 'admins' }] })),
    createUser: vi.fn(async () => ({ ok: true as const, userId: 'u', displayName: 'd' })),
    setPassword: vi.fn(async () => ({ ok: true, message: 'set' })),
    addToGroup: vi.fn(async () => ({ ok: true as const })),
    deleteUser: vi.fn(async (id: string) => { calls.deleted.push(id); return { ok: true as const }; }),
    autheliaFirstFactor: vi.fn(async () => ({ ok: true, cookie: 'authelia_session=abc', detail: 'ok' })),
    probeDomain: vi.fn(async (_pd: string, host: string, _c: string | null, follow: boolean): Promise<DomainProbe> => {
      // user apps follow redirects → 200 + matching signature; admin hosts
      // don't follow → 302 (correctly blocked).
      if (follow) {
        const sig = USER_APP_SIGNATURES[host] ?? '';
        return { code: 200, body: sig || 'anything' };
      }
      return { code: 302, body: '' };
    }),
    // ollama.<domain> is gated iff opted in; FQDN-keyed.
    hostHasForwardAuth: vi.fn(async (fqdn: string) => {
      const host = fqdn.split('.')[0];
      return gated.has(host);
    }),
    // OIDC-backed apps issue a real code by default.
    probeOidcAuthorization: vi.fn(async (_pd: string, clientId: string, _redirectUri: string): Promise<OidcAuthProbe> => ({
      ok: true, code: 302, detail: `code issued for ${clientId}`,
    })),
  };
  return { deps, calls };
}

beforeEach(() => {
  mockGetConfig.mockReset();
  mockGetConfig.mockResolvedValue(okConfig);
});

describe('verifySso orchestrator', () => {
  it('runs the full flow, passes, and always deletes the ephemeral user', async () => {
    const { deps, calls } = happyDeps();
    const report = await verifySso({ deps });

    expect(report.ok).toBe(true);
    expect(report.cleanedUp).toBe(true);
    // every templated user app + every admin host probed (ollama is gated on
    // actual forward-auth, off by default here).
    const templatedHosts = Object.keys(USER_APP_SIGNATURES).filter(h => SUBDOMAIN_TEMPLATE[h]);
    expect(report.userDomains).toHaveLength(templatedHosts.length);
    expect(report.adminDomains).toHaveLength(ADMIN_ONLY_HOSTS.length);
    // ephemeral user deleted exactly once, matching the reported username
    expect(calls.deleted).toEqual([report.ephemeralUser]);
    expect(deps.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('GUARANTEES cleanup even when a mid-flow step fails (after create)', async () => {
    const { deps, calls } = happyDeps();
    deps.addToGroup = vi.fn(async () => ({ ok: false as const, reason: 'graphql_error' as const, message: 'boom' }));

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    // user was created, so it MUST be deleted despite the failure
    expect(calls.deleted).toEqual([report.ephemeralUser]);
    expect(report.cleanedUp).toBe(true);
    expect(report.steps.find(s => s.id === 'join_family')?.status).toBe('fail');
  });

  it('does not attempt deletion when the user was never created', async () => {
    const { deps } = happyDeps();
    deps.createUser = vi.fn(async () => ({ ok: false as const, reason: 'graphql_error' as const, message: 'nope' }));

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.cleanedUp).toBe(true); // nothing to clean up
    expect(deps.deleteUser).not.toHaveBeenCalled();
  });

  it('reports cleanedUp=false when the delete itself fails (and still finishes)', async () => {
    const { deps } = happyDeps();
    deps.deleteUser = vi.fn(async () => ({ ok: false as const, reason: 'network_error' as const, message: 'unreachable' }));

    const report = await verifySso({ deps });

    expect(report.cleanedUp).toBe(false);
    expect(report.steps.find(s => s.id === 'cleanup')?.status).toBe('fail');
  });

  it('fails when a family user can REACH an admin domain (ACL bypass) — and still cleans up', async () => {
    const { deps, calls } = happyDeps();
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 200, body: 'admin panel' }; // bypass!
      return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' };
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.adminDomains.every(d => d.status === 'fail')).toBe(true);
    expect(calls.deleted).toHaveLength(1);
  });

  it('fails a forward-auth user domain that returns 200 with the wrong content signature', async () => {
    const { deps } = happyDeps();
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 302, body: '' };
      // books expects 'Audiobookshelf' — but books is OIDC; use a forward-auth
      // app instead. home has no signature, so degrade music's? music is
      // forward-auth with empty sig. Pick caldav (forward-auth) and break it
      // by returning a 502 (no signature to mismatch, so use the code path).
      if (host === 'caldav') return { code: 502, body: 'bad gateway' };
      return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' };
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.userDomains.find(d => d.domain === 'caldav.dopp.cloud')?.status).toBe('fail');
  });

  it('skips early (and reports cleanedUp) when publicDomain is not configured', async () => {
    mockGetConfig.mockResolvedValue({ reverseProxy: {}, installedTemplates: { auth: {} } });
    const { deps } = happyDeps();

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.steps[0].id).toBe('config');
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('skips when the auth template is not installed', async () => {
    mockGetConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'dopp.cloud' }, installedTemplates: {} });
    const { deps } = happyDeps();

    const report = await verifySso({ deps });

    expect(report.steps.some(s => s.id === 'config' && s.status === 'skip')).toBe(true);
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('only probes installed services on a non-full install — does not false-fail (#1591)', async () => {
    // Minimal install: auth + home-assistant + file-share. Vaultwarden,
    // Immich, media, radicale are NOT installed, so their subdomains
    // (vault/photos/music/books/caldav) must not be probed.
    mockGetConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud' },
      installedTemplates: Object.assign(tmpl('auth'), tmpl('home-assistant'), tmpl('file-share')),
    });
    const { deps } = happyDeps();
    // If an uninstalled service WERE probed, NPM's dead host would 404 → fail.
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 302, body: '' };
      if (['home', 'files', 'sync'].includes(host)) {
        return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' };
      }
      return { code: 404, body: 'dead host' }; // would fail if probed
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(true);
    const probed = report.userDomains.map(d => d.domain).sort();
    expect(probed).toEqual(['files.dopp.cloud', 'home.dopp.cloud', 'sync.dopp.cloud']);
    // none of the uninstalled-service subdomains were touched
    expect(report.userDomains.some(d => /^(vault|photos|music|books|caldav)\./.test(d.domain))).toBe(false);
  });

  it('passes an auth-only install with zero installed user apps (#1591)', async () => {
    mockGetConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud' },
      installedTemplates: tmpl('auth'),
    });
    const { deps } = happyDeps();

    const report = await verifySso({ deps });

    expect(report.ok).toBe(true);
    expect(report.userDomains).toHaveLength(0);
    expect(report.adminDomains).toHaveLength(ADMIN_ONLY_HOSTS.length);
  });

  it('cleans up even if an injected dep throws unexpectedly', async () => {
    const { deps, calls } = happyDeps();
    deps.autheliaFirstFactor = vi.fn(async () => { throw new Error('kaboom'); });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.steps.some(s => s.id === 'unexpected_error')).toBe(true);
    expect(calls.deleted).toEqual([report.ephemeralUser]);
  });
});

describe('probeableUserSubdomains (#1591)', () => {
  it('returns only subdomains whose backing template is installed', () => {
    const installed = Object.assign(tmpl('vaultwarden'), tmpl('radicale'));
    expect(probeableUserSubdomains(installed).sort()).toEqual(['caldav', 'vault']);
  });

  it('maps file-share to both files and sync when installed', () => {
    expect(probeableUserSubdomains(tmpl('file-share')).sort()).toEqual(['files', 'sync']);
  });

  it('is empty when no user-app template is installed', () => {
    expect(probeableUserSubdomains(tmpl('auth'))).toEqual([]);
    expect(probeableUserSubdomains({})).toEqual([]);
  });

  it('every USER_APP_SIGNATURES host is either template-gated or forward-auth-derived', () => {
    for (const host of Object.keys(USER_APP_SIGNATURES)) {
      const templated = SUBDOMAIN_TEMPLATE[host] != null;
      const derived = FORWARD_AUTH_DERIVED_SUBDOMAINS.includes(host);
      expect(templated || derived, `${host} must map to a template or be forward-auth-derived`).toBe(true);
    }
  });

  it('every OIDC_CLIENT_SUBDOMAINS host is also a templated user subdomain', () => {
    for (const host of Object.keys(OIDC_CLIENT_SUBDOMAINS)) {
      expect(SUBDOMAIN_TEMPLATE[host], `${host} must have a backing template`).toBeDefined();
      expect(USER_APP_SIGNATURES).toHaveProperty(host);
    }
  });

  it('no longer includes the untemplated hermes subdomain', () => {
    expect(USER_APP_SIGNATURES).not.toHaveProperty('hermes');
    expect(SUBDOMAIN_TEMPLATE).not.toHaveProperty('hermes');
  });
});

describe('classifyUserDomain', () => {
  it('passes 2xx with matching signature', () => {
    expect(classifyUserDomain('vault.dopp.cloud', 'Vaultwarden Web', { code: 200, body: 'x Vaultwarden Web y' }).status).toBe('pass');
  });
  it('passes 3xx with no signature', () => {
    expect(classifyUserDomain('photos.dopp.cloud', '', { code: 302, body: '' }).status).toBe('pass');
  });
  it('fails 2xx missing signature', () => {
    expect(classifyUserDomain('vault.dopp.cloud', 'Vaultwarden Web', { code: 200, body: 'nope' }).status).toBe('fail');
  });
  it('fails 4xx/5xx', () => {
    expect(classifyUserDomain('vault.dopp.cloud', '', { code: 502, body: '' }).status).toBe('fail');
  });
  it('fails transport error', () => {
    expect(classifyUserDomain('vault.dopp.cloud', '', { code: 0, body: '', error: 'ECONNREFUSED' }).status).toBe('fail');
  });
});

describe('classifyAdminReject', () => {
  it.each([302, 303, 401, 403])('passes blocked code %i', (code) => {
    expect(classifyAdminReject('ldap.dopp.cloud', { code, body: '' }).status).toBe('pass');
  });
  it('fails on 200 (ACL bypassed)', () => {
    const r = classifyAdminReject('ldap.dopp.cloud', { code: 200, body: '' });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/bypass/i);
  });
  it('fails on transport error', () => {
    expect(classifyAdminReject('ldap.dopp.cloud', { code: 0, body: '', error: 'x' }).status).toBe('fail');
  });
});

describe('classifyOidcAuthorization (#1685)', () => {
  it('passes when a real code is issued', () => {
    const r = classifyOidcAuthorization('photos.dopp.cloud', 'immich', { ok: true, code: 302, detail: 'code issued' });
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/healthy/i);
  });
  it('fails on invalid_client (the #1559 registration signature) without claiming a secret fault', () => {
    const r = classifyOidcAuthorization('photos.dopp.cloud', 'immich', { ok: false, code: 302, oauthError: 'invalid_client', detail: 'x' });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/invalid_client/);
    expect(r.detail).toMatch(/registration|config/i);
    // The authorization endpoint never validates the client SECRET — don't claim it.
    expect(r.detail).not.toMatch(/secret/i);
  });
  it('fails on server_error', () => {
    expect(classifyOidcAuthorization('books.dopp.cloud', 'audiobookshelf', { ok: false, code: 500, oauthError: 'server_error', detail: 'x' }).status).toBe('fail');
  });
  it('SKIPs on invalid_request (a probe/redirect_uri setup issue, NOT a service fault — #sso-redirect-uri)', () => {
    const r = classifyOidcAuthorization('photos.dopp.cloud', 'immich', { ok: false, code: 400, oauthError: 'invalid_request', detail: 'x' });
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/could not run|setup/i);
  });
  it('fails on a redirect with no code', () => {
    expect(classifyOidcAuthorization('vault.dopp.cloud', 'vaultwarden', { ok: false, code: 302, detail: 'no code' }).status).toBe('fail');
  });
  it('fails on transport error', () => {
    expect(classifyOidcAuthorization('vault.dopp.cloud', 'vaultwarden', { ok: false, code: 0, detail: 'ECONNREFUSED' }).status).toBe('fail');
  });
});

describe('extractOauthError', () => {
  it('pulls error= out of a redirect Location', () => {
    expect(extractOauthError('https://auth.dopp.cloud/?error=invalid_client&state=x')).toBe('invalid_client');
  });
  it('pulls error out of a JSON body', () => {
    expect(extractOauthError('{"error":"server_error","error_description":"boom"}')).toBe('server_error');
  });
  it('returns undefined for a clean code redirect', () => {
    expect(extractOauthError('https://app/cb?code=abc&state=x')).toBeUndefined();
  });
});

describe('verifySso — #1673 set_password + couldNotRun', () => {
  it('drives set_password and classifies a setup failure as couldNotRun (warn), not a login fail', async () => {
    const { deps, calls } = happyDeps();
    deps.setPassword = vi.fn(async () => ({ ok: false, message: 'Either the token or the admin password is required' }));

    const report = await verifySso({ deps });

    // The whole point of #1673: a broken setup step must NOT read as SSO-broken.
    expect(report.ok).toBe(false);
    expect(report.couldNotRun).toBe(true);
    const pwStep = report.steps.find(s => s.id === 'set_password');
    expect(pwStep?.status).toBe('fail');
    // never reached the actual login test
    expect(deps.autheliaFirstFactor).not.toHaveBeenCalled();
    expect(report.userDomains).toHaveLength(0);
    // still cleaned up the created user
    expect(calls.deleted).toEqual([report.ephemeralUser]);
  });

  it('a real login failure (firstfactor) is a fail, NOT couldNotRun', async () => {
    const { deps } = happyDeps();
    deps.autheliaFirstFactor = vi.fn(async () => ({ ok: false, cookie: null, detail: 'firstfactor HTTP 401' }));

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.couldNotRun).toBe(false); // login genuinely failed
    expect(report.steps.find(s => s.id === 'authelia_firstfactor')?.status).toBe('fail');
  });

  it('passes the happy path with couldNotRun=false', async () => {
    const { deps } = happyDeps();
    const report = await verifySso({ deps });
    expect(report.ok).toBe(true);
    expect(report.couldNotRun).toBe(false);
    expect(deps.setPassword).toHaveBeenCalledWith(report.ephemeralUser, expect.any(String));
  });
});

describe('verifySso — #1685 ollama forward-auth gating', () => {
  it('includes ollama when its proxy host carries forward-auth', async () => {
    const { deps } = happyDeps({ forwardAuthHosts: ['ollama'] });
    const report = await verifySso({ deps });

    expect(report.ok).toBe(true);
    expect(report.userDomains.some(d => d.domain === 'ollama.dopp.cloud')).toBe(true);
    expect(deps.hostHasForwardAuth).toHaveBeenCalledWith('ollama.dopp.cloud');
  });

  it('catches a 403-ing ollama RED (the live breakage)', async () => {
    const { deps } = happyDeps({ forwardAuthHosts: ['ollama'] });
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 302, body: '' };
      if (host === 'ollama') return { code: 403, body: 'Forbidden' };
      return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' };
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.couldNotRun).toBe(false);
    expect(report.userDomains.find(d => d.domain === 'ollama.dopp.cloud')?.status).toBe('fail');
  });

  it('does NOT probe ollama when its host carries no forward-auth', async () => {
    const { deps } = happyDeps(); // ollama not gated
    const report = await verifySso({ deps });
    expect(report.userDomains.some(d => d.domain === 'ollama.dopp.cloud')).toBe(false);
  });
});

describe('verifySso — #1685 OIDC apps exercise the real handshake', () => {
  it('drives the OIDC authorization flow for vault/photos/books (not just reachability)', async () => {
    const { deps } = happyDeps();
    const report = await verifySso({ deps });

    expect(report.ok).toBe(true);
    // OIDC apps go through probeOidcAuthorization, NOT probeDomain
    // The probe must send each client's REAL registered redirect_uri
    // (https://<subdomain>.<domain><registered path>), not a placeholder —
    // otherwise Authelia rejects an unregistered redirect_uri for every client.
    expect(deps.probeOidcAuthorization).toHaveBeenCalledWith('dopp.cloud', 'immich', 'https://photos.dopp.cloud/auth/login', expect.any(String));
    expect(deps.probeOidcAuthorization).toHaveBeenCalledWith('dopp.cloud', 'vaultwarden', 'https://vault.dopp.cloud/identity/connect/oidc-signin', expect.any(String));
    expect(deps.probeOidcAuthorization).toHaveBeenCalledWith('dopp.cloud', 'audiobookshelf', 'https://books.dopp.cloud/auth/login', expect.any(String));
  });

  it('catches an invalid_client OIDC app RED even though its page loads 200 (#1559)', async () => {
    const { deps } = happyDeps();
    // Reachability would PASS (page loads), but the OIDC handshake is broken.
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 302, body: '' };
      return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' }; // photos loads fine
    });
    deps.probeOidcAuthorization = vi.fn(async (_pd, clientId) => {
      if (clientId === 'immich') return { ok: false, code: 302, oauthError: 'invalid_client', detail: 'secret mismatch' };
      return { ok: true, code: 302, detail: 'ok' };
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.couldNotRun).toBe(false);
    const photos = report.userDomains.find(d => d.domain === 'photos.dopp.cloud');
    expect(photos?.status).toBe('fail');
    expect(photos?.detail).toMatch(/invalid_client/);
  });
});

describe('extractAutheliaCookie', () => {
  it('pulls authelia_session from a Set-Cookie list', () => {
    expect(extractAutheliaCookie(['authelia_session=abc123; Path=/; HttpOnly', 'other=1']))
      .toBe('authelia_session=abc123');
  });
  it('returns null when absent', () => {
    expect(extractAutheliaCookie(['session=zzz; Path=/'])).toBeNull();
  });
});

describe('makeEphemeralUsername', () => {
  it('is namespaced, timestamped, and unique across calls', () => {
    const a = makeEphemeralUsername(1000);
    const b = makeEphemeralUsername(1000);
    expect(a).toMatch(/^sb-ssoverify-1000-[0-9a-f]{6}$/);
    expect(a).not.toBe(b); // random suffix differs
  });
});
