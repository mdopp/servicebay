import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCookieGet = vi.fn();
const mockGetConfig = vi.fn();
const mockDecrypt = vi.fn();

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: mockCookieGet })) }));
vi.mock('@/lib/config', () => ({ getConfig: () => mockGetConfig() }));
vi.mock('@/lib/auth/session', () => ({ decrypt: (t: string) => mockDecrypt(t) }));

import { assertAdminSession } from './_session';

describe('assertAdminSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows unauthenticated calls during onboarding (!setupCompleted)', async () => {
    mockGetConfig.mockResolvedValue({ setupCompleted: false });
    mockCookieGet.mockReturnValue(undefined);
    await expect(assertAdminSession()).resolves.toBeUndefined();
  });

  it('throws when setup is complete and no session cookie is present', async () => {
    mockGetConfig.mockResolvedValue({ setupCompleted: true });
    mockCookieGet.mockReturnValue(undefined);
    await expect(assertAdminSession()).rejects.toThrow(/Unauthorized/);
  });

  it('throws when the session token is invalid', async () => {
    mockGetConfig.mockResolvedValue({ setupCompleted: true });
    mockCookieGet.mockReturnValue({ value: 'bad-token' });
    mockDecrypt.mockResolvedValue(null);
    await expect(assertAdminSession()).rejects.toThrow(/Unauthorized/);
  });

  it('passes with a valid authenticated session', async () => {
    mockGetConfig.mockResolvedValue({ setupCompleted: true });
    mockCookieGet.mockReturnValue({ value: 'good-token' });
    mockDecrypt.mockResolvedValue({ user: 'admin' });
    await expect(assertAdminSession()).resolves.toBeUndefined();
  });
});
