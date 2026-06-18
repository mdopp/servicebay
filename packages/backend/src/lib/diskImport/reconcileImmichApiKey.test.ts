import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/install/savedSecrets', () => ({
  loadSavedSecrets: vi.fn(),
  persistSingleSecret: vi.fn(async () => undefined),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from '@/lib/install/savedSecrets';
import { reconcileImmichApiKey, IMMICH_ADMIN_API_KEY_VAR } from './reconcileImmichApiKey';

const SERVER = 'http://127.0.0.1:2283';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConfig).mockResolvedValue({} as never);
  vi.mocked(loadSavedSecrets).mockReturnValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reconcileImmichApiKey', () => {
  it('is a no-op when a key is already stored', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({ [IMMICH_ADMIN_API_KEY_VAR]: 'existing' });
    const r = await reconcileImmichApiKey(SERVER);
    expect(r.outcome).toBe('aligned');
  });

  it('errors with the exact missing key when no email AND no password are resolvable', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    vi.mocked(getConfig).mockResolvedValue({} as never);
    const r = await reconcileImmichApiKey(SERVER);
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('admin email');
    expect(r.message).toContain('IMMICH_ADMIN_PASSWORD');
  });

  it('derives the admin email from config.notifications.email.to[0] when the secret keys are absent', async () => {
    // Password is stored, but NO email key in the secret store — the normal box
    // state. The email must fall back to the operator email in config.
    vi.mocked(loadSavedSecrets).mockReturnValue({ IMMICH_ADMIN_PASSWORD: 'pw' });
    vi.mocked(getConfig).mockResolvedValue({
      notifications: { email: { to: ['operator@example.com'] } },
    } as never);

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      void _init;
      if (url.endsWith('/api/auth/login')) {
        return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 201 });
      }
      if (url.endsWith('/api/api-keys')) {
        return new Response(JSON.stringify({ secret: 'minted-key' }), { status: 201 });
      }
      return new Response('null', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await reconcileImmichApiKey(SERVER);
    expect(r.outcome).toBe('minted');
    // logged in with the config-derived email
    const loginCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/auth/login'))!;
    const loginBody = JSON.parse((loginCall[1] as RequestInit).body as string);
    expect(loginBody.email).toBe('operator@example.com');
    expect(persistSingleSecret).toHaveBeenCalledWith(IMMICH_ADMIN_API_KEY_VAR, 'minted-key');
  });
});
