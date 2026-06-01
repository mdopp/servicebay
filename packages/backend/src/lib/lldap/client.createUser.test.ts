import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import { createLldapUser } from './client';

const input = { id: 'alice', email: 'alice@example.com', displayName: 'Alice' };

beforeEach(() => {
  mockGetConfig.mockResolvedValue({ lldap: { url: 'http://lldap:17170', username: 'admin', password: 'pw' } });
  vi.restoreAllMocks();
});

/** auth/simple/login succeeds, then the graphql call returns `graphqlBody`. */
function stubFetch(graphqlBody: unknown) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'jwt' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => graphqlBody });
  vi.stubGlobal('fetch', fetchMock);
}

describe('createLldapUser duplicate handling (#1425)', () => {
  it('maps a raw SQLite UNIQUE-constraint error on email to a friendly already-exists outcome', async () => {
    stubFetch({ errors: [{ message: 'Execution Error: error returned from database: (code: 2067) UNIQUE constraint failed: users.lowercase_email' }] });

    const res = await createLldapUser(input);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('username_taken');
      // The raw SQLite error must never reach the operator.
      expect(res.message).not.toMatch(/UNIQUE constraint|code: 2067|database/i);
      expect(res.message).toContain('alice@example.com');
    }
  });

  it('maps a username UNIQUE-constraint error to a friendly username-taken message', async () => {
    stubFetch({ errors: [{ message: 'UNIQUE constraint failed: users.user_id' }] });

    const res = await createLldapUser(input);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('username_taken');
      expect(res.message).not.toMatch(/UNIQUE constraint/i);
      expect(res.message).toContain('alice');
    }
  });

  it('still maps the friendly "already exists" wording to username_taken', async () => {
    stubFetch({ errors: [{ message: 'User already exists' }] });

    const res = await createLldapUser(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('username_taken');
  });

  it('leaves an unrelated GraphQL error as graphql_error', async () => {
    stubFetch({ errors: [{ message: 'schema validation failed' }] });

    const res = await createLldapUser(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('graphql_error');
  });

  it('returns the created user on success', async () => {
    stubFetch({ data: { createUser: { id: 'alice', displayName: 'Alice' } } });

    const res = await createLldapUser(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.userId).toBe('alice');
  });
});
