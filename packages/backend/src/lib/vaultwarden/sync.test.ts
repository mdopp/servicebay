/**
 * Sync-orchestration tests (#2519).
 *
 * The acceptance criterion under test here is the destructive one:
 * ServiceBay deletes its own copy of a password. These cases pin that it
 * happens **only** for an entry the vault confirmed by read-back, that a
 * partial or failed push leaves everything else visibly unsecured, and
 * that no "well, it probably worked" path exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '@/lib/config';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';

let mockConfig: Partial<AppConfig> = {};
const saveConfigMock = vi.fn(async (cfg: AppConfig) => {
  mockConfig = cfg;
});
vi.mock('@/lib/config', () => ({
  getConfig: async () => mockConfig as AppConfig,
  saveConfig: (cfg: AppConfig) => saveConfigMock(cfg),
}));
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: async () => ({ VAULTWARDEN_PORT: { type: 'text', default: '8222' } }),
}));

const upsert = vi.fn(async (item: { key: string }) => ({ id: `id-${item.key}`, created: true }));
const verify = vi.fn(async (_id: string, _item: { name: string }) => true);
const connectVault = vi.fn(async () => ({ upsert, verify, baseUrl: 'http://host.containers.internal:8222' }));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, connectVault: (...args: unknown[]) => connectVault(...(args as [])) };
});

import { resolveVaultBaseUrls, syncCredentialsToVault, toVaultItem } from './sync';
import { VaultwardenError } from './client';

const IMMICH: Credential = {
  service: 'Immich', url: 'http://localhost:2283', username: 'admin@dopp.cloud',
  password: 'immich-secret', importance: 'critical', template: 'immich',
};
const LLDAP: Credential = {
  service: 'LLDAP', url: 'https://ldap.dopp.cloud', username: 'admin',
  password: 'lldap-secret', importance: 'critical', template: 'auth',
};

function configWith(credentials: Credential[], overrides: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    installedTemplates: { vaultwarden: { schemaVersion: 1, installedAt: '2026-08-01T00:00:00Z' } },
    installManifest: { savedAt: '2026-08-01T00:00:00Z', credentials: credentials as never },
    credentialVault: {
      accountEmail: 'servicebay@dopp.cloud',
      password: 'vault-account-master-password',
      organizationId: 'org-1',
      collectionId: 'col-1',
    },
    ...overrides,
  };
}

const creds = () => (mockConfig.installManifest?.credentials ?? []) as unknown as Credential[];

beforeEach(() => {
  mockConfig = {};
  saveConfigMock.mockClear();
  upsert.mockClear();
  verify.mockClear();
  connectVault.mockClear();
  upsert.mockImplementation(async (item: { key: string }) => ({ id: `id-${item.key}`, created: true }));
  verify.mockImplementation(async () => true);
  connectVault.mockImplementation(async () => ({ upsert, verify, baseUrl: 'http://host.containers.internal:8222' }));
});

describe('syncCredentialsToVault', () => {
  it('drops the local password only after the vault confirmed the item', async () => {
    mockConfig = configWith([IMMICH]);
    const result = await syncCredentialsToVault({ trigger: 'test' });

    expect(result).toMatchObject({ ok: true, attempted: 1, secured: 1 });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(creds()[0].password).toBe('');
    expect(creds()[0].securedAt).toBe(result.at);
  });

  it('KEEPS the password when the read-back did not confirm — the whole point', async () => {
    mockConfig = configWith([IMMICH]);
    verify.mockResolvedValue(false);

    const result = await syncCredentialsToVault();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('verify_failed');
    expect(creds()[0].password).toBe('immich-secret');
    expect(creds()[0].securedAt).toBeUndefined();
    expect(mockConfig.credentialVault?.lastSync).toMatchObject({ ok: false, reason: 'verify_failed', secured: 0, attempted: 1 });
  });

  it('secures only the confirmed entry when one of two fails', async () => {
    mockConfig = configWith([IMMICH, LLDAP]);
    verify.mockImplementation(async (_id, item) => item.name === 'LLDAP');

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: false, attempted: 2, secured: 1 });
    const [immich, lldap] = creds();
    expect(immich.password).toBe('immich-secret');
    expect(immich.securedAt).toBeUndefined();
    expect(lldap.password).toBe('');
    expect(lldap.securedAt).toBe(result.at);
  });

  it('keeps everything when the push itself fails, and records why', async () => {
    mockConfig = configWith([IMMICH, LLDAP]);
    connectVault.mockRejectedValue(new VaultwardenError('unreachable', 'connect ECONNREFUSED'));

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: false, reason: 'unreachable', secured: 0, attempted: 2 });
    expect(creds().every(c => c.password && !c.securedAt)).toBe(true);
    expect(mockConfig.credentialVault?.lastSync).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('surviving entries are still pushed when one entry throws', async () => {
    mockConfig = configWith([IMMICH, LLDAP]);
    upsert.mockImplementation(async (item: { key: string }) => {
      if (item.key.startsWith('immich')) throw new VaultwardenError('push_failed', 'HTTP 500 from /api/ciphers/create');
      return { id: 'id-lldap', created: true };
    });

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: false, reason: 'push_failed', secured: 1, attempted: 2 });
    expect(creds()[0].password).toBe('immich-secret');
    expect(creds()[1].password).toBe('');
  });

  it('does nothing — and writes nothing — when there is no vault account', async () => {
    mockConfig = configWith([IMMICH], { credentialVault: undefined });

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(connectVault).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(creds()[0].password).toBe('immich-secret');
  });

  it('does nothing when Vaultwarden is not installed on this box', async () => {
    mockConfig = configWith([IMMICH], { installedTemplates: {} });

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(result.message).toMatch(/not installed/);
    expect(connectVault).not.toHaveBeenCalled();
  });

  it('is a no-op once everything is already secured', async () => {
    mockConfig = configWith([{ ...IMMICH, password: '', securedAt: '2026-08-10T00:00:00Z' }]);

    const result = await syncCredentialsToVault();

    expect(result).toMatchObject({ ok: true, attempted: 0, secured: 0 });
    expect(connectVault).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('never re-pushes an entry whose password ServiceBay already dropped', async () => {
    mockConfig = configWith([{ ...IMMICH, password: '', securedAt: '2026-08-10T00:00:00Z' }, LLDAP]);

    await syncCredentialsToVault();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ name: 'LLDAP' });
    // The already-secured entry keeps its ORIGINAL timestamp.
    expect(creds()[0].securedAt).toBe('2026-08-10T00:00:00Z');
  });
});

describe('vault item + addressing', () => {
  it('addresses the box over host.containers.internal, with loopback as fallback', async () => {
    const urls = await resolveVaultBaseUrls({} as AppConfig);
    expect(urls).toEqual(['http://host.containers.internal:8222', 'http://127.0.0.1:8222']);
    // ADR 0007 Decision 3 — never an IP literal, never LAN_IP, never the
    // public domain (that would route a machine call through NPM+Authelia).
    expect(urls.some(u => /\b\d+\.\d+\.\d+\.\d+\b/.test(u) && !u.includes('127.0.0.1'))).toBe(false);
  });

  it('honours an operator-set VAULTWARDEN_PORT', async () => {
    const urls = await resolveVaultBaseUrls({ installedVariables: [{ varName: 'VAULTWARDEN_PORT', value: '9999' }] } as AppConfig);
    expect(urls[0]).toBe('http://host.containers.internal:9999');
  });

  it('uses an explicit override verbatim', async () => {
    const urls = await resolveVaultBaseUrls({} as AppConfig, 'https://vault.internal/');
    expect(urls).toEqual(['https://vault.internal']);
  });

  it('gives the item a stable identity and an admin-reachable URI', () => {
    const item = toVaultItem(IMMICH, {
      reverseProxy: { publicDomain: 'dopp.cloud', hosts: [{ domain: 'photos.dopp.cloud', service: 'immich' }] },
    } as unknown as AppConfig);
    expect(item.key).toBe('immich::Immich::admin@dopp.cloud');
    expect(item.uri).toBe('https://photos.dopp.cloud');
    expect(item.notes).toContain('Written by ServiceBay');
  });

  it('leaves out a URI that is not a browsable URL', () => {
    const item = toVaultItem({ ...IMMICH, url: 'env: LLDAP_JWT_SECRET' }, {} as AppConfig);
    expect(item.uri).toBeUndefined();
  });
});
