/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@/lib/install/jobStore', () => ({
  wasInstallActiveWithin: vi.fn().mockResolvedValue(false),
}));

import {
  isLanIp,
  lazyInitializeExpiry,
  verifyBootstrapToken,
  revokeBootstrapToken,
  getBootstrapTokenStatus,
} from './bootstrapToken';
import { getConfig, updateConfig } from '@/lib/config';
import { wasInstallActiveWithin } from '@/lib/install/jobStore';

const mockGetConfig = getConfig as any;
const mockUpdateConfig = updateConfig as any;
const mockWasInstallActiveWithin = wasInstallActiveWithin as any;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  mockGetConfig.mockReset();
  mockUpdateConfig.mockReset();
  mockWasInstallActiveWithin.mockReset().mockResolvedValue(false);
});

describe('isLanIp', () => {
  it('accepts loopback', () => {
    expect(isLanIp('127.0.0.1')).toBe(true);
    expect(isLanIp('::1')).toBe(true);
    expect(isLanIp('::ffff:127.0.0.1')).toBe(true);
  });
  it('accepts RFC1918', () => {
    expect(isLanIp('10.0.0.5')).toBe(true);
    expect(isLanIp('172.16.0.1')).toBe(true);
    expect(isLanIp('172.31.255.255')).toBe(true);
    expect(isLanIp('192.168.178.100')).toBe(true);
  });
  it('rejects 172.32.* (just outside RFC1918)', () => {
    expect(isLanIp('172.32.0.1')).toBe(false);
    expect(isLanIp('172.15.0.1')).toBe(false);
  });
  it('accepts IPv6 ULA + link-local', () => {
    expect(isLanIp('fc00::1')).toBe(true);
    expect(isLanIp('fd12::1')).toBe(true);
    expect(isLanIp('fe80::1')).toBe(true);
  });
  it('rejects public IPs', () => {
    expect(isLanIp('1.1.1.1')).toBe(false);
    expect(isLanIp('8.8.8.8')).toBe(false);
    expect(isLanIp('2001:4860:4860::8888')).toBe(false);
  });
  it('rejects empty / null', () => {
    expect(isLanIp('')).toBe(false);
    expect(isLanIp(undefined)).toBe(false);
    expect(isLanIp(null)).toBe(false);
  });
});

describe('verifyBootstrapToken', () => {
  it('returns null when no bootstrap-token entry exists', async () => {
    mockGetConfig.mockResolvedValue({ auth: {} });
    expect(await verifyBootstrapToken('any-token', '127.0.0.1')).toBeNull();
  });

  it('rejects requests from non-LAN IPs even with the right token', async () => {
    mockGetConfig.mockResolvedValue({
      auth: { bootstrapToken: { hash: sha256('right-token'), scope: 'read' } },
    });
    expect(await verifyBootstrapToken('right-token', '8.8.8.8')).toBeNull();
  });

  it('rejects wrong tokens', async () => {
    mockGetConfig.mockResolvedValue({
      auth: { bootstrapToken: { hash: sha256('right-token'), scope: 'read' } },
    });
    expect(await verifyBootstrapToken('wrong-token', '127.0.0.1')).toBeNull();
  });

  it('rejects expired tokens by throwing an error', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: sha256('right-token'),
          scope: 'read',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
    await expect(verifyBootstrapToken('right-token', '127.0.0.1')).rejects.toThrow('Bootstrap token expired');
  });

  it('accepts expired tokens if a setup job was active recently', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: sha256('right-token'),
          scope: 'read',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
    mockWasInstallActiveWithin.mockResolvedValue(true);
    const ctx = await verifyBootstrapToken('right-token', '127.0.0.1');
    expect(ctx).toEqual({
      user: 'bootstrap',
      scopes: ['read'],
      tokenId: 'bootstrap',
    });
  });

  it('accepts a correct token from a LAN IP within the window', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: sha256('right-token'),
          scope: 'read',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const ctx = await verifyBootstrapToken('right-token', '192.168.1.10');
    expect(ctx).toEqual({
      user: 'bootstrap',
      scopes: ['read'],
      tokenId: 'bootstrap',
    });
  });

  it('uses constant-time compare (sanity: rejects same-length wrong hash)', async () => {
    mockGetConfig.mockResolvedValue({
      auth: { bootstrapToken: { hash: sha256('right-token'), scope: 'read' } },
    });
    // Pass a different token whose own hash has the same length (always true
    // for sha256). The compare should reject.
    expect(await verifyBootstrapToken('different-token-here', '127.0.0.1')).toBeNull();
  });
});

describe('lazyInitializeExpiry', () => {
  it('writes expiresAt when hash exists but expiresAt is unset', async () => {
    mockGetConfig.mockResolvedValue({
      auth: { bootstrapToken: { hash: 'abc', scope: 'read' } },
    });
    await lazyInitializeExpiry();
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateConfig.mock.calls[0][0];
    expect(arg.auth.bootstrapToken.hash).toBe('abc');
    const t = Date.parse(arg.auth.bootstrapToken.expiresAt);
    // ~30 min from now; allow a 1 min jitter for test slowness
    expect(t).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(t).toBeLessThan(Date.now() + 31 * 60_000);
  });

  it('no-ops when expiresAt already set', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: 'abc',
          scope: 'read',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      },
    });
    await lazyInitializeExpiry();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('no-ops when no bootstrap-token entry exists', async () => {
    mockGetConfig.mockResolvedValue({ auth: {} });
    await lazyInitializeExpiry();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('revokeBootstrapToken', () => {
  it('removes the bootstrapToken entry from auth', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        username: 'admin',
        passwordHash: 'kept',
        bootstrapToken: { hash: 'abc', scope: 'read' },
      },
    });
    expect(await revokeBootstrapToken()).toBe(true);
    const arg = mockUpdateConfig.mock.calls[0][0];
    expect(arg.auth.bootstrapToken).toBeUndefined();
    expect(arg.auth.username).toBe('admin');
    expect(arg.auth.passwordHash).toBe('kept');
  });

  it('returns false when nothing to revoke', async () => {
    mockGetConfig.mockResolvedValue({ auth: { username: 'admin' } });
    expect(await revokeBootstrapToken()).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('getBootstrapTokenStatus', () => {
  it('returns inactive when no token', async () => {
    mockGetConfig.mockResolvedValue({ auth: {} });
    expect(await getBootstrapTokenStatus()).toEqual({ active: false });
  });

  it('returns active + minutes remaining when within window', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: 'abc',
          scope: 'read',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      },
    });
    const s = await getBootstrapTokenStatus();
    expect(s.active).toBe(true);
    expect((s as any).minutesRemaining).toBeGreaterThanOrEqual(9);
    expect((s as any).minutesRemaining).toBeLessThanOrEqual(10);
  });

  it('returns inactive when expired', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: 'abc',
          scope: 'read',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
    expect(await getBootstrapTokenStatus()).toEqual({ active: false });
  });

  it('returns active when expired but a setup job was active recently', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        bootstrapToken: {
          hash: 'abc',
          scope: 'read',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
    mockWasInstallActiveWithin.mockResolvedValue(true);
    expect(await getBootstrapTokenStatus()).toEqual({ active: true, expiresAt: null, minutesRemaining: null });
  });
});
