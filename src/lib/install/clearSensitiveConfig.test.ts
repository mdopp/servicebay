/**
 * clearSensitiveConfig — #623 / Factory Reset.
 *
 * The factory-reset endpoint relies on this helper to wipe in-memory +
 * on-disk secret state that survives a stacks-only reset. The contract:
 * removes the field entirely (not just sets empty), preserves unrelated
 * keys inside `reverseProxy`, and reports which fields were actually
 * cleared so the UI can show a meaningful summary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

let mockConfigState: Partial<AppConfig> = {};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState as AppConfig),
  saveConfig: vi.fn(async (config: AppConfig) => {
    mockConfigState = config;
  }),
}));

import { clearSensitiveConfig } from './clearSensitiveConfig';
import type { AppConfig } from '@/lib/config';
import { saveConfig } from '@/lib/config';

const saveConfigMock = vi.mocked(saveConfig);

beforeEach(() => {
  mockConfigState = {};
  saveConfigMock.mockClear();
});

describe('clearSensitiveConfig', () => {
  it('removes installedSecrets, installManifest, lldap, adguard, and reverseProxy.npm', async () => {
    mockConfigState = {
      installedSecrets: [{ varName: 'LLDAP_ADMIN_PASSWORD', password: 'pw' }],
      installManifest: { credentials: [] } as never,
      lldap: { url: 'http://x', username: 'admin', password: 'pw' },
      adguard: { adminUrl: 'http://x', username: 'admin', password: 'pw' },
      reverseProxy: {
        publicDomain: 'example.com',
        npm: { email: 'admin@x', password: 'pw' },
      } as never,
    };

    const result = await clearSensitiveConfig();

    expect(result.cleared.sort()).toEqual([
      'adguard',
      'installManifest',
      'installedSecrets',
      'lldap',
      'reverseProxy.npm',
    ]);
    expect(mockConfigState.installedSecrets).toBeUndefined();
    expect(mockConfigState.installManifest).toBeUndefined();
    expect(mockConfigState.lldap).toBeUndefined();
    expect(mockConfigState.adguard).toBeUndefined();
    expect(mockConfigState.reverseProxy?.npm).toBeUndefined();
  });

  it('preserves operator-set fields on reverseProxy (only npm is sensitive)', async () => {
    mockConfigState = {
      reverseProxy: {
        publicDomain: 'example.com',
        lanDomain: 'home.arpa',
        npm: { email: 'admin@x', password: 'pw' },
      } as never,
    };

    await clearSensitiveConfig();

    expect(mockConfigState.reverseProxy).toEqual({
      publicDomain: 'example.com',
      lanDomain: 'home.arpa',
    });
  });

  it('reports an empty cleared list when nothing was set', async () => {
    mockConfigState = {};
    const result = await clearSensitiveConfig();
    expect(result.cleared).toEqual([]);
    // saveConfig still runs — the call is the canonical write-and-flush
    // signal, and the wipe step is idempotent.
    expect(saveConfigMock).toHaveBeenCalledOnce();
  });

  it('treats an empty installedSecrets array as already-cleared', async () => {
    mockConfigState = { installedSecrets: [] };
    const result = await clearSensitiveConfig();
    expect(result.cleared).toEqual([]);
  });

  it('does not touch unrelated fields', async () => {
    mockConfigState = {
      serverName: 'pi.home',
      domain: 'home.arpa',
      autoUpdate: { enabled: true, schedule: '0 0 * * *' } as never,
      installedSecrets: [{ varName: 'X', password: 'y' }],
    };

    await clearSensitiveConfig();

    expect(mockConfigState.serverName).toBe('pi.home');
    expect(mockConfigState.domain).toBe('home.arpa');
    expect(mockConfigState.autoUpdate).toEqual({ enabled: true, schedule: '0 0 * * *' });
    expect(mockConfigState.installedSecrets).toBeUndefined();
  });
});
