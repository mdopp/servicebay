import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import { exportLldapDirectory } from './client';

beforeEach(() => {
  mockGetConfig.mockResolvedValue({ lldap: { url: 'http://lldap:17170', username: 'admin', password: 'pw' } });
  vi.restoreAllMocks();
});

describe('exportLldapDirectory', () => {
  it('returns users (with groups) + the group list, no passwords', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'jwt' }) }) // /auth/simple/login
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            users: [{ id: 'alice', email: 'a@x', displayName: 'Alice', groups: [{ displayName: 'admins' }] }],
            groups: [{ displayName: 'admins' }, { displayName: 'family' }],
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const res = await exportLldapDirectory();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.directory.users).toEqual([
        { id: 'alice', email: 'a@x', displayName: 'Alice', groups: ['admins'] },
      ]);
      expect(res.directory.groups).toEqual(['admins', 'family']);
      expect(res.directory.exportedAt).toBeTruthy();
    }
  });

  it('surfaces a GraphQL error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'jwt' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await exportLldapDirectory();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('graphql_error');
    }
  });

  it('reports not_configured when LLDAP creds are missing', async () => {
    mockGetConfig.mockResolvedValue({});
    const res = await exportLldapDirectory();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_configured');
  });
});
