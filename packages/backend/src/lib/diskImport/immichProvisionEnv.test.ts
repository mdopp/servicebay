import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reconcileImmichApiKey', () => ({
  IMMICH_ADMIN_API_KEY_VAR: 'IMMICH_ADMIN_API_KEY',
  reconcileImmichApiKey: vi.fn(),
}));
vi.mock('@/lib/install/savedSecrets', () => ({ loadSavedSecrets: vi.fn() }));
vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/lldap/client', () => ({ listLldapUsers: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { reconcileImmichApiKey } from './reconcileImmichApiKey';
import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import { getConfig } from '@/lib/config';
import { listLldapUsers } from '@/lib/lldap/client';
import { logger } from '@/lib/logger';
import { resolveImmichProvisionEnv, IMMICH_SERVER_URL } from './immichProvisionEnv';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconcileImmichApiKey).mockResolvedValue({ outcome: 'aligned', message: '' });
  vi.mocked(getConfig).mockResolvedValue({} as never);
});

describe('resolveImmichProvisionEnv', () => {
  it('reconciles, lists users, and returns the -e env args', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({ IMMICH_ADMIN_API_KEY: 'k-123' });
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'mdopp', email: 'm@x' }, { id: 'cdopp' }],
    });

    const env = await resolveImmichProvisionEnv();
    expect(reconcileImmichApiKey).toHaveBeenCalledWith(IMMICH_SERVER_URL);
    expect(env).toContain('IMMICH_ADMIN_API_KEY=k-123');
    expect(env).toContain(`IMMICH_SERVER_URL=${IMMICH_SERVER_URL}`);
    const usersArg = env.find(a => a.startsWith('DISK_IMPORT_BOX_USERS='))!;
    expect(JSON.parse(usersArg.slice('DISK_IMPORT_BOX_USERS='.length))).toEqual([
      { id: 'mdopp', email: 'm@x' },
      { id: 'cdopp' },
    ]);
  });

  it('returns [] (no-op) when no admin key is available — Immich not installed', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    expect(await resolveImmichProvisionEnv()).toEqual([]);
    expect(listLldapUsers).not.toHaveBeenCalled();
  });

  it('warns (does not swallow) when no key resolves, surfacing the reconcile reason', async () => {
    vi.mocked(reconcileImmichApiKey).mockResolvedValue({
      outcome: 'error',
      message: 'No stored Immich admin credentials — missing admin email; cannot mint an admin API key.',
    });
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    expect(await resolveImmichProvisionEnv()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'disk-import:immich',
      expect.stringContaining('No stored Immich admin credentials'),
    );
  });

  it('still injects when the user directory is unavailable (Shared library only)', async () => {
    vi.mocked(loadSavedSecrets).mockReturnValue({ IMMICH_ADMIN_API_KEY: 'k' });
    vi.mocked(listLldapUsers).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'down' });
    const env = await resolveImmichProvisionEnv();
    expect(env).toContain('DISK_IMPORT_BOX_USERS=[]');
    expect(env).toContain('IMMICH_ADMIN_API_KEY=k');
  });

  it('never throws — a reconcile error yields []', async () => {
    vi.mocked(reconcileImmichApiKey).mockRejectedValue(new Error('immich down'));
    expect(await resolveImmichProvisionEnv()).toEqual([]);
  });
});
