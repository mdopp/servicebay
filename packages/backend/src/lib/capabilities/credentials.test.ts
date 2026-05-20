/**
 * Credentials manifest capability handler tests (#631).
 *
 * Mocks `@/lib/config` so we can drive the read-merge-write cycle
 * without touching disk. `buildCredentialsManifest` runs for real —
 * it's pure and already tested elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '@/lib/config';

let mockConfig: Partial<AppConfig> = {};
const saveConfigMock = vi.fn(async (cfg: AppConfig) => {
  mockConfig = cfg;
});

vi.mock('@/lib/config', () => ({
  getConfig: async () => mockConfig as AppConfig,
  saveConfig: (cfg: AppConfig) => saveConfigMock(cfg),
}));

import { handleInstalled, handleUninstalled } from './credentials';
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

const MANIFEST: TemplateManifest = {
  label: 'X', tier: 'feature', schemaVersion: 1, dependencies: [],
};

function oidcSubdomainVar(template: string, subVarName: string, clientId: string, secretVar: string): StackVariable {
  return {
    name: subVarName,
    value: 'photos',
    meta: {
      type: 'subdomain',
      templateName: template,
      oidcClient: {
        client_id: clientId,
        client_name: clientId,
        authorization_policy: 'one_factor',
        redirect_uris: ['/'],
        scopes: ['openid'],
        clientSecretVar: secretVar,
      },
    } as StackVariable['meta'],
  };
}

beforeEach(() => {
  mockConfig = {};
  saveConfigMock.mockClear();
});

describe('credentials.handleInstalled', () => {
  it('persists generated OIDC entries tagged with the template name', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [
        { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
        oidcSubdomainVar('immich', 'IMMICH_SUBDOMAIN', 'immich', 'IMMICH_SSO_SECRET'),
        { name: 'IMMICH_SSO_SECRET', value: 'super-secret' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(saveConfigMock).toHaveBeenCalledOnce();
    const creds = mockConfig.installManifest!.credentials;
    expect(creds).toHaveLength(1);
    expect(creds[0].username).toBe('immich');
    expect(creds[0].password).toBe('super-secret');
    expect((creds[0] as { template?: string }).template).toBe('immich');
  });

  it('replaces existing entries owned by the same template on re-install', async () => {
    // Seed the manifest with a stale entry for the same template.
    mockConfig = {
      installManifest: {
        savedAt: '2026-05-19T00:00:00.000Z',
        credentials: [
          { service: 'immich OIDC client_secret', url: 'https://auth.dopp.cloud', username: 'immich', password: 'stale', importance: 'system', template: 'immich' } as never,
          { service: 'vaultwarden OIDC client_secret', url: 'https://auth.dopp.cloud', username: 'vaultwarden', password: 'keep', importance: 'system', template: 'vaultwarden' } as never,
        ],
      },
    };
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [
        { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
        oidcSubdomainVar('immich', 'IMMICH_SUBDOMAIN', 'immich', 'IMMICH_SSO_SECRET'),
        { name: 'IMMICH_SSO_SECRET', value: 'fresh' },
      ],
    });
    expect(r.ok).toBe(true);
    const creds = mockConfig.installManifest!.credentials;
    // immich entry now `fresh`, vaultwarden untouched.
    const immich = creds.find(c => (c as { template?: string }).template === 'immich');
    const vault = creds.find(c => (c as { template?: string }).template === 'vaultwarden');
    expect(immich?.password).toBe('fresh');
    expect(vault?.password).toBe('keep');
  });

  it('preserves untagged legacy entries', async () => {
    mockConfig = {
      installManifest: {
        savedAt: '2026-05-19T00:00:00.000Z',
        credentials: [
          { service: 'legacy', url: 'x', username: 'u', password: 'p', importance: 'system' } as never,
        ],
      },
    };
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [
        { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
        oidcSubdomainVar('immich', 'IMMICH_SUBDOMAIN', 'immich', 'IMMICH_SSO_SECRET'),
        { name: 'IMMICH_SSO_SECRET', value: 'fresh' },
      ],
    });
    expect(r.ok).toBe(true);
    const creds = mockConfig.installManifest!.credentials;
    expect(creds.find(c => c.service === 'legacy')).toBeTruthy();
    expect(creds.find(c => (c as { template?: string }).template === 'immich')).toBeTruthy();
  });

  it('no-ops when builder produces no entries', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'noop', manifest: MANIFEST,
      variables: [],
    });
    expect(r.ok).toBe(true);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});

describe('credentials.handleUninstalled', () => {
  it('removes entries owned by the template, keeps others', async () => {
    mockConfig = {
      installManifest: {
        savedAt: '2026-05-19T00:00:00.000Z',
        credentials: [
          { service: 'immich OIDC', url: 'x', username: 'immich', password: 'p1', importance: 'system', template: 'immich' } as never,
          { service: 'immich extra', url: 'x', username: 'u', password: 'p2', importance: 'critical', template: 'immich' } as never,
          { service: 'vaultwarden OIDC', url: 'x', username: 'v', password: 'pv', importance: 'system', template: 'vaultwarden' } as never,
          { service: 'untagged-legacy', url: 'x', username: 'u', password: 'pl', importance: 'critical' } as never,
        ],
      },
    };
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
    const creds = mockConfig.installManifest!.credentials;
    expect(creds.find(c => (c as { template?: string }).template === 'immich')).toBeUndefined();
    expect(creds.find(c => (c as { template?: string }).template === 'vaultwarden')).toBeTruthy();
    expect(creds.find(c => c.service === 'untagged-legacy')).toBeTruthy();
  });

  it('no-ops with ok:true when no matching entries exist', async () => {
    mockConfig = {
      installManifest: {
        savedAt: '2026-05-19T00:00:00.000Z',
        credentials: [
          { service: 'v', url: 'x', username: 'v', password: 'p', importance: 'system', template: 'vaultwarden' } as never,
        ],
      },
    };
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('no-ops with ok:true when manifest is empty', async () => {
    mockConfig = {};
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
  });
});
