import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import { userIsInLldapGroup } from './client';

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

// #2270 — the authoritative admin-membership check the delegated-admin guard
// consults. Never trusts a caller's role claim; asks SB's own LLDAP.
describe('userIsInLldapGroup', () => {
  it('returns inGroup:true when the user is a member (case-insensitive)', async () => {
    stubFetch({ data: { user: { id: 'alice', groups: [{ displayName: 'Admins' }, { displayName: 'family' }] } } });
    const r = await userIsInLldapGroup('alice', 'admins');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inGroup).toBe(true);
  });

  it('returns inGroup:false when the user is not in the group', async () => {
    stubFetch({ data: { user: { id: 'bob', groups: [{ displayName: 'family' }] } } });
    const r = await userIsInLldapGroup('bob', 'admins');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inGroup).toBe(false);
  });

  it('treats an unknown user as a definitive non-member (not an error)', async () => {
    stubFetch({ errors: [{ message: 'Entity not found' }] });
    const r = await userIsInLldapGroup('ghost', 'admins');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inGroup).toBe(false);
  });

  it('empty user id is a non-member without a network call', async () => {
    const r = await userIsInLldapGroup('', 'admins');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inGroup).toBe(false);
  });

  it('fails closed (ok:false) on a directory/network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await userIsInLldapGroup('alice', 'admins');
    expect(r.ok).toBe(false);
  });

  it('fails closed (ok:false) when LLDAP creds are absent', async () => {
    mockGetConfig.mockResolvedValue({});
    const r = await userIsInLldapGroup('alice', 'admins');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_configured');
  });
});
