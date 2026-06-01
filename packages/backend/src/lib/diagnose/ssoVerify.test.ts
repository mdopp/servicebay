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
  extractAutheliaCookie,
  makeEphemeralUsername,
  USER_APP_SIGNATURES,
  ADMIN_ONLY_HOSTS,
  type SsoVerifyDeps,
  type DomainProbe,
} from './ssoVerify';

const okConfig = {
  reverseProxy: { publicDomain: 'dopp.cloud' },
  installedTemplates: { auth: { schemaVersion: 1, installedAt: '2026-05-01T00:00:00Z' } },
};

/** Deps where every step succeeds and every domain behaves correctly. */
function happyDeps(): { deps: SsoVerifyDeps; calls: { deleted: string[] } } {
  const calls = { deleted: [] as string[] };
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
    // every user app + every admin host probed
    expect(report.userDomains).toHaveLength(Object.keys(USER_APP_SIGNATURES).length);
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

  it('fails a user domain that returns 200 with the wrong content signature', async () => {
    const { deps } = happyDeps();
    deps.probeDomain = vi.fn(async (_pd, host, _c, follow) => {
      if (!follow) return { code: 302, body: '' };
      // vault expects 'Vaultwarden Web' but we return junk
      if (host === 'vault') return { code: 200, body: '<html>error page</html>' };
      return { code: 200, body: USER_APP_SIGNATURES[host] || 'ok' };
    });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.userDomains.find(d => d.domain === 'vault.dopp.cloud')?.status).toBe('fail');
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

  it('cleans up even if an injected dep throws unexpectedly', async () => {
    const { deps, calls } = happyDeps();
    deps.autheliaFirstFactor = vi.fn(async () => { throw new Error('kaboom'); });

    const report = await verifySso({ deps });

    expect(report.ok).toBe(false);
    expect(report.steps.some(s => s.id === 'unexpected_error')).toBe(true);
    expect(calls.deleted).toEqual([report.ephemeralUser]);
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
