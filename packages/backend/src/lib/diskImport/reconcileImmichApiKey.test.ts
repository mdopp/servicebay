import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/install/savedSecrets', () => ({
  loadSavedSecrets: vi.fn(),
  persistSingleSecret: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from '@/lib/install/savedSecrets';
import { reconcileImmichApiKey } from './reconcileImmichApiKey';

const URL = 'http://127.0.0.1:2283';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(getConfig).mockResolvedValue({} as never);
});

describe('reconcileImmichApiKey', () => {
  it('is a no-op when a key is already stored', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({ IMMICH_ADMIN_API_KEY: 'have' });
    const res = await reconcileImmichApiKey(URL);
    expect(res.outcome).toBe('aligned');
    expect(persistSingleSecret).not.toHaveBeenCalled();
  });

  it('errors when no admin credentials are stored', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    const res = await reconcileImmichApiKey(URL);
    expect(res.outcome).toBe('error');
    expect(res.message).toMatch(/admin credentials/i);
  });

  it('logs in and mints a key, persisting it under the secret var', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({
      IMMICH_ADMIN_EMAIL: 'a@x',
      IMMICH_ADMIN_PASSWORD: 'pw',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).slice(URL.length);
        if (path === '/api/auth/login') {
          return { status: 201, json: async () => ({ accessToken: 'tok' }) } as Response;
        }
        if (path === '/api/api-keys') {
          expect(init?.method).toBe('POST');
          return { status: 201, json: async () => ({ secret: 'minted-key' }) } as Response;
        }
        throw new Error(`unexpected ${path}`);
      }),
    );

    const res = await reconcileImmichApiKey(URL);
    expect(res.outcome).toBe('minted');
    expect(persistSingleSecret).toHaveBeenCalledWith('IMMICH_ADMIN_API_KEY', 'minted-key');
  });

  it('errors (no mint) when admin login is rejected', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({
      IMMICH_ADMIN_EMAIL: 'a@x',
      IMMICH_ADMIN_PASSWORD: 'wrong',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, json: async () => ({}) }) as Response),
    );
    const res = await reconcileImmichApiKey(URL);
    expect(res.outcome).toBe('error');
    expect(persistSingleSecret).not.toHaveBeenCalled();
  });
});
