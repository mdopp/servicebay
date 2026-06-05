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
  clientIpForLanGate,
  lazyInitializeExpiry,
  verifyBootstrapToken,
  revokeBootstrapToken,
  getBootstrapTokenStatus,
  reactivateBootstrapToken,
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
  it('deactivates by expiring in place — KEEPS the hash, sets expiresAt to the past (#1705)', async () => {
    mockGetConfig.mockResolvedValue({
      auth: {
        username: 'admin',
        passwordHash: 'kept',
        bootstrapToken: { hash: 'abc', scope: 'read' },
      },
    });
    expect(await revokeBootstrapToken()).toBe(true);
    const arg = mockUpdateConfig.mock.calls[0][0];
    // Hash is preserved (so it stays re-activatable), but expiresAt is in the past.
    expect(arg.auth.bootstrapToken.hash).toBe('abc');
    expect(arg.auth.bootstrapToken.scope).toBe('read');
    expect(Date.parse(arg.auth.bootstrapToken.expiresAt)).toBeLessThan(Date.now());
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
    expect(await getBootstrapTokenStatus()).toEqual({ active: false, present: false });
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
    expect(await getBootstrapTokenStatus()).toEqual({ active: false, present: true });
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
    expect(await getBootstrapTokenStatus()).toEqual({ active: true, present: true, expiresAt: null, minutesRemaining: null });
  });
});

describe('reactivateBootstrapToken (#1419)', () => {
  it('re-issues the same token with a fresh ~30 min window', async () => {
    mockGetConfig.mockResolvedValue({ auth: { bootstrapToken: { hash: 'abc', scope: 'read', expiresAt: new Date(Date.now() - 60_000).toISOString() } } });
    const r = await reactivateBootstrapToken();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.minutesRemaining).toBe(30);
      expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    }
    const arg = mockUpdateConfig.mock.calls[0][0];
    expect(arg.auth.bootstrapToken.hash).toBe('abc');
    expect(Date.parse(arg.auth.bootstrapToken.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('is a no-op (no-bootstrap-token) only when no entry was ever installed', async () => {
    mockGetConfig.mockResolvedValue({ auth: {} });
    const r = await reactivateBootstrapToken();
    expect(r).toEqual({ ok: false, reason: 'no-bootstrap-token' });
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

// End-to-end: minting a named token deactivates (but keeps) the bootstrap
// token, so it stays re-activatable and a configured MCP client reconnects
// with the SAME token value (#1705 — the regression that #322 deletion caused).
describe('mint → re-activate → reconnect round-trip (#1705)', () => {
  const RAW = 'bootstrap-secret';

  // Drive an actual revoke (simulating the first named-token mint), capturing
  // the written config so a follow-up getConfig sees the deactivated entry.
  async function deactivateAndCapture() {
    mockGetConfig.mockResolvedValue({
      auth: { bootstrapToken: { hash: sha256(RAW), scope: 'read', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    });
    await revokeBootstrapToken();
    const written = mockUpdateConfig.mock.calls[0][0].auth.bootstrapToken;
    mockGetConfig.mockResolvedValue({ auth: { bootstrapToken: written } });
    return written;
  }

  it('after a mint-revoke, status is present:true / active:false (re-activatable, not gone)', async () => {
    await deactivateAndCapture();
    expect(await getBootstrapTokenStatus()).toEqual({ active: false, present: true });
  });

  it('an un-reactivated (still-expired) bootstrap token stays inert — verify rejects', async () => {
    await deactivateAndCapture();
    await expect(verifyBootstrapToken(RAW, '192.168.1.10')).rejects.toThrow('Bootstrap token expired');
  });

  it('reactivate resets the TTL on the kept hash, then verify succeeds from a LAN IP', async () => {
    await deactivateAndCapture();
    mockUpdateConfig.mockClear();

    const r = await reactivateBootstrapToken();
    expect(r.ok).toBe(true);

    // Persist the reactivation result and verify the ORIGINAL token value works.
    const written = mockUpdateConfig.mock.calls[0][0].auth.bootstrapToken;
    expect(written.hash).toBe(sha256(RAW));
    mockGetConfig.mockResolvedValue({ auth: { bootstrapToken: written } });

    const ctx = await verifyBootstrapToken(RAW, '192.168.1.10');
    expect(ctx).toEqual({ user: 'bootstrap', scopes: ['read'], tokenId: 'bootstrap' });
  });
});

describe('clientIpForLanGate (#1204)', () => {
  it('returns the socket address unchanged for a direct (non-loopback) peer', () => {
    expect(clientIpForLanGate({}, '203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores proxy headers on a direct connection (no header spoofing)', () => {
    // A direct internet client cannot fake a LAN IP via headers.
    expect(clientIpForLanGate({ 'x-real-ip': '192.168.1.5' }, '203.0.113.7')).toBe('203.0.113.7');
  });

  it('trusts X-Real-IP when the peer is the local proxy (loopback)', () => {
    expect(clientIpForLanGate({ 'x-real-ip': '203.0.113.7' }, '127.0.0.1')).toBe('203.0.113.7');
    // and isLanIp then correctly rejects the public client
    expect(isLanIp(clientIpForLanGate({ 'x-real-ip': '203.0.113.7' }, '127.0.0.1'))).toBe(false);
  });

  it('uses the RIGHTMOST X-Forwarded-For hop (nginx-appended), not the spoofable left', () => {
    // Client spoofs a LAN IP; NPM appends the real peer on the right.
    const xff = '192.168.1.5, 203.0.113.7';
    expect(clientIpForLanGate({ 'x-forwarded-for': xff }, '::1')).toBe('203.0.113.7');
  });

  it('prefers X-Real-IP over X-Forwarded-For', () => {
    expect(clientIpForLanGate({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '8.8.8.8' }, '127.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to the loopback socket address when no proxy headers are present', () => {
    expect(clientIpForLanGate({}, '127.0.0.1')).toBe('127.0.0.1');
  });
});
