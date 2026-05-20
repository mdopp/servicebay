/**
 * loadSavedSecrets + persistInstalledSecrets — #615.
 *
 * Validates the two contracts the install runner depends on:
 *   1. `loadSavedSecrets` returns a flat varName→value map drawn from
 *      `installedSecrets` (canonical) AND the legacy `config.lldap` /
 *      `config.reverseProxy.npm` / `config.adguard` fields (back-compat).
 *      Canonical wins on collision.
 *   2. `persistInstalledSecrets` merges with whatever's already saved
 *      so partial re-installs don't blow away secrets for templates
 *      that weren't touched this run.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mocked config store: getConfig returns whatever updateConfig last wrote.
// persistSingleSecret does a read-modify-write through both, so the tests
// need them coupled rather than independent stubs.
let mockConfigState: Partial<AppConfig> = {};
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState as AppConfig),
  updateConfig: vi.fn(async (updates: Partial<AppConfig>) => {
    mockConfigState = { ...mockConfigState, ...updates };
    return mockConfigState as AppConfig;
  }),
}));

import { loadSavedSecrets, persistInstalledSecrets, persistSingleSecret } from './savedSecrets';
import type { AppConfig } from '@/lib/config';
import { updateConfig } from '@/lib/config';
import type { StackVariable } from '@/lib/stackInstall/types';

const updateConfigMock = vi.mocked(updateConfig);

beforeEach(() => {
  updateConfigMock.mockClear();
  mockConfigState = {};
});

function mkConfig(partial: Partial<AppConfig>): AppConfig {
  return partial as AppConfig;
}

describe('loadSavedSecrets', () => {
  it('returns the legacy fields when installedSecrets is absent', () => {
    const out = loadSavedSecrets(mkConfig({
      lldap: { url: 'http://x', username: 'admin', password: 'lldap-pw' },
      adguard: { adminUrl: 'http://x', username: 'admin', password: 'adg-pw' },
      reverseProxy: { npm: { email: 'op@x', password: 'npm-pw' } },
    }));
    expect(out).toEqual({
      LLDAP_ADMIN_PASSWORD: 'lldap-pw',
      ADGUARD_ADMIN_PASSWORD: 'adg-pw',
      NGINX_ADMIN_PASSWORD: 'npm-pw',
      NGINX_ADMIN_EMAIL: 'op@x',
    });
  });

  it('layers installedSecrets over legacy fields (canonical wins)', () => {
    const out = loadSavedSecrets(mkConfig({
      lldap: { url: 'http://x', username: 'admin', password: 'old-legacy' },
      installedSecrets: [
        { varName: 'LLDAP_ADMIN_PASSWORD', password: 'new-canonical' },
        { varName: 'IMMICH_ADMIN_PASSWORD', password: 'immich-pw' },
      ],
    }));
    expect(out.LLDAP_ADMIN_PASSWORD).toBe('new-canonical');
    expect(out.IMMICH_ADMIN_PASSWORD).toBe('immich-pw');
  });

  it('skips entries with empty varName or password', () => {
    const out = loadSavedSecrets(mkConfig({
      installedSecrets: [
        { varName: '', password: 'x' },
        { varName: 'GOOD', password: '' },
        { varName: 'KEEP', password: 'pw' },
      ],
    }));
    expect(out).toEqual({ KEEP: 'pw' });
  });

  it('returns an empty map when config has neither layer', () => {
    expect(loadSavedSecrets(mkConfig({}))).toEqual({});
  });
});

describe('persistInstalledSecrets', () => {
  const vars = (entries: Array<{ name: string; value: string; type: string }>): StackVariable[] =>
    entries.map(e => ({ name: e.name, value: e.value, meta: { type: e.type } as StackVariable['meta'] }));

  it('saves every secret/bcrypt/rsa-private value to installedSecrets', async () => {
    await persistInstalledSecrets(vars([
      { name: 'LLDAP_ADMIN_PASSWORD', value: 'lldap-pw', type: 'secret' },
      { name: 'ADGUARD_ADMIN_PASSWORD_HASH', value: 'bcrypt-hash', type: 'bcrypt' },
      { name: 'AUTHELIA_OIDC_RSA_PRIVATE_KEY', value: '-----BEGIN-----', type: 'rsa-private' },
      { name: 'LLDAP_PORT', value: '17170', type: 'text' }, // non-secret — skipped
    ]), mkConfig({}));
    expect(updateConfigMock).toHaveBeenCalledOnce();
    const arg = updateConfigMock.mock.calls[0][0] as { installedSecrets: Array<{ varName: string; password: string }> };
    const names = arg.installedSecrets.map(e => e.varName).sort();
    expect(names).toEqual(['ADGUARD_ADMIN_PASSWORD_HASH', 'AUTHELIA_OIDC_RSA_PRIVATE_KEY', 'LLDAP_ADMIN_PASSWORD']);
  });

  it('merges with existing entries — partial re-installs preserve untouched secrets', async () => {
    await persistInstalledSecrets(vars([
      { name: 'IMMICH_ADMIN_PASSWORD', value: 'fresh', type: 'secret' },
    ]), mkConfig({
      installedSecrets: [
        { varName: 'LLDAP_ADMIN_PASSWORD', value: 'from-prior-install' } as never,
        { varName: 'IMMICH_ADMIN_PASSWORD', password: 'stale' },
      ],
    }));
    const arg = updateConfigMock.mock.calls[0][0] as { installedSecrets: Array<{ varName: string; password: string }> };
    const map = new Map(arg.installedSecrets.map(e => [e.varName, e.password]));
    // LLDAP entry came from prior config and was carried forward.
    expect(map.has('LLDAP_ADMIN_PASSWORD')).toBe(true);
    // IMMICH entry was rewritten with the fresh value.
    expect(map.get('IMMICH_ADMIN_PASSWORD')).toBe('fresh');
  });

  it('skips empty-value vars rather than clobbering a saved value', async () => {
    await persistInstalledSecrets(vars([
      { name: 'LLDAP_ADMIN_PASSWORD', value: '', type: 'secret' }, // empty
    ]), mkConfig({
      installedSecrets: [
        { varName: 'LLDAP_ADMIN_PASSWORD', password: 'keep-me' },
      ],
    }));
    const arg = updateConfigMock.mock.calls[0][0] as { installedSecrets: Array<{ varName: string; password: string }> };
    expect(arg.installedSecrets).toEqual([{ varName: 'LLDAP_ADMIN_PASSWORD', password: 'keep-me' }]);
  });
});

describe('persistSingleSecret (#622 — persist at first generation)', () => {
  it('appends a new entry on first call', async () => {
    const wrote = await persistSingleSecret('LLDAP_ADMIN_PASSWORD', 'pw-1');
    expect(wrote).toBe(true);
    expect(mockConfigState.installedSecrets).toEqual([
      { varName: 'LLDAP_ADMIN_PASSWORD', password: 'pw-1' },
    ]);
  });

  it('is idempotent — same name+value is a no-op', async () => {
    await persistSingleSecret('LLDAP_ADMIN_PASSWORD', 'pw-1');
    updateConfigMock.mockClear();
    const wrote = await persistSingleSecret('LLDAP_ADMIN_PASSWORD', 'pw-1');
    expect(wrote).toBe(false);
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('updates the entry in place when the value changes (operator rotation)', async () => {
    await persistSingleSecret('LLDAP_ADMIN_PASSWORD', 'pw-old');
    await persistSingleSecret('LLDAP_ADMIN_PASSWORD', 'pw-new');
    expect(mockConfigState.installedSecrets).toEqual([
      { varName: 'LLDAP_ADMIN_PASSWORD', password: 'pw-new' },
    ]);
  });

  it('preserves entries from prior installs when appending a new one', async () => {
    mockConfigState = {
      installedSecrets: [{ varName: 'PRIOR', password: 'keep' }],
    };
    await persistSingleSecret('NEW', 'fresh');
    expect(mockConfigState.installedSecrets).toEqual([
      { varName: 'PRIOR', password: 'keep' },
      { varName: 'NEW', password: 'fresh' },
    ]);
  });

  it('skips writes when varName or value is empty', async () => {
    expect(await persistSingleSecret('', 'value')).toBe(false);
    expect(await persistSingleSecret('NAME', '')).toBe(false);
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('serializes concurrent upserts so neither write is lost', async () => {
    // Without the internal queue, both calls would read the same empty list,
    // each compute a single-entry array, and the second write would clobber
    // the first. With the queue, the second call sees the first's write.
    await Promise.all([
      persistSingleSecret('A', '1'),
      persistSingleSecret('B', '2'),
    ]);
    const names = (mockConfigState.installedSecrets ?? []).map(e => e.varName).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('round-trips through loadSavedSecrets', async () => {
    await persistSingleSecret('IMMICH_ADMIN_PASSWORD', 'immich-pw');
    await persistSingleSecret('AUTHELIA_JWT_SECRET', 'jwt-pw');
    const loaded = loadSavedSecrets(mockConfigState as AppConfig);
    expect(loaded).toEqual({
      IMMICH_ADMIN_PASSWORD: 'immich-pw',
      AUTHELIA_JWT_SECRET: 'jwt-pw',
    });
  });
});
