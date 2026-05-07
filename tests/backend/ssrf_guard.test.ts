// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { isPrivateAddress } from '../../src/lib/health/ssrfGuard';

describe('isPrivateAddress', () => {
  const cases: Array<[string, boolean]> = [
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // outside the 16-31 range
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
    ['100.64.0.1', true], // CGNAT
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['224.0.0.1', true], // multicast
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['2001:4860:4860::8888', false], // public IPv6
    ['::ffff:192.168.1.1', true], // IPv4-mapped private
    ['::ffff:8.8.8.8', false], // IPv4-mapped public
  ];
  for (const [ip, expected] of cases) {
    it(`${ip} -> ${expected ? 'private' : 'public'}`, () => {
      expect(isPrivateAddress(ip)).toBe(expected);
    });
  }
});

describe('assertHttpTargetAllowed', () => {
  beforeEach(() => {
    delete process.env.MONITORING_ALLOW_INTERNAL;
  });

  it('rejects literal IPv4 loopback', async () => {
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('http://127.0.0.1/')).rejects.toThrow();
  });

  it('rejects literal RFC1918', async () => {
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('http://10.0.0.5:8080/')).rejects.toThrow();
  });

  it('rejects literal AWS metadata IP', async () => {
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('rejects bare localhost hostname without DNS', async () => {
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('http://localhost:6379/')).rejects.toThrow();
  });

  it('rejects unsupported protocols', async () => {
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('file:///etc/passwd')).rejects.toThrow(/protocol/);
  });

  it('opt-in via MONITORING_ALLOW_INTERNAL=1', async () => {
    process.env.MONITORING_ALLOW_INTERNAL = '1';
    const { assertHttpTargetAllowed } = await import('../../src/lib/health/ssrfGuard');
    await expect(assertHttpTargetAllowed('http://192.168.1.1/')).resolves.toBeUndefined();
  });
});
