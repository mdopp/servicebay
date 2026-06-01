import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListLldapUsers } = vi.hoisted(() => ({ mockListLldapUsers: vi.fn() }));
vi.mock('@/lib/lldap/client', () => ({ listLldapUsers: () => mockListLldapUsers() }));

import { isOverUserLimit, DEFAULT_MAX_USERS } from './userCap';

const usersOk = (n: number) => ({ ok: true, users: Array.from({ length: n }, (_, i) => ({ id: `u${i}` })) });

beforeEach(() => vi.restoreAllMocks());

describe('isOverUserLimit (#1426)', () => {
  it('default cap is 20', () => {
    expect(DEFAULT_MAX_USERS).toBe(20);
  });

  it('is over when approved users + pending reach the limit', async () => {
    mockListLldapUsers.mockResolvedValue(usersOk(4));
    expect(await isOverUserLimit(5, 1)).toBe(true);  // 4 + 1 >= 5
    expect(await isOverUserLimit(5, 2)).toBe(true);  // 4 + 2 >  5
  });

  it('is under when there is room', async () => {
    mockListLldapUsers.mockResolvedValue(usersOk(3));
    expect(await isOverUserLimit(5, 1)).toBe(false); // 3 + 1 < 5
  });

  it('counts pending requests against the limit (blocks before approval)', async () => {
    mockListLldapUsers.mockResolvedValue(usersOk(0));
    expect(await isOverUserLimit(3, 3)).toBe(true);  // 0 users but 3 pending == 3
  });

  it('fails open (false) when LLDAP is unreachable — cannot size the cap', async () => {
    mockListLldapUsers.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'down' });
    expect(await isOverUserLimit(1, 99)).toBe(false);
  });
});
