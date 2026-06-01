import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import { listLldapGroups, addUserToLldapGroup, deleteLldapUser } from './client';

beforeEach(() => {
  mockGetConfig.mockResolvedValue({ lldap: { url: 'http://lldap:17170', username: 'admin', password: 'pw' } });
  vi.restoreAllMocks();
});

/** auth/simple/login succeeds, then the graphql call returns `graphqlBody`. */
function stubFetch(graphqlBody: unknown) {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'jwt' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => graphqlBody }));
}

describe('listLldapGroups', () => {
  it('returns the group list', async () => {
    stubFetch({ data: { groups: [{ id: 1, displayName: 'admins' }, { id: 2, displayName: 'family' }] } });
    const r = await listLldapGroups();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.groups.find(g => g.displayName === 'family')?.id).toBe(2);
  });

  it('surfaces a graphql error', async () => {
    stubFetch({ errors: [{ message: 'boom' }] });
    const r = await listLldapGroups();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('graphql_error');
  });

  it('fails with not_configured when LLDAP creds are absent', async () => {
    mockGetConfig.mockResolvedValue({});
    const r = await listLldapGroups();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_configured');
  });
});

describe('addUserToLldapGroup', () => {
  it('returns ok when LLDAP confirms', async () => {
    stubFetch({ data: { addUserToGroup: { ok: true } } });
    const r = await addUserToLldapGroup('alice', 2);
    expect(r.ok).toBe(true);
  });

  it('fails when LLDAP does not confirm ok:true', async () => {
    stubFetch({ data: { addUserToGroup: { ok: false } } });
    const r = await addUserToLldapGroup('alice', 2);
    expect(r.ok).toBe(false);
  });
});

describe('deleteLldapUser', () => {
  it('returns ok when deletion confirmed', async () => {
    stubFetch({ data: { deleteUser: { ok: true } } });
    const r = await deleteLldapUser('alice');
    expect(r.ok).toBe(true);
  });

  it('fails when LLDAP reports an error (e.g. user already gone)', async () => {
    stubFetch({ errors: [{ message: 'no such user' }] });
    const r = await deleteLldapUser('ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('graphql_error');
  });
});
