import { describe, it, expect, afterEach } from 'vitest';
import {
  assertHttpTargetAllowed,
  isKnownLocalSystemTarget,
  isPrivateAddress,
} from './ssrfGuard';

describe('ssrfGuard', () => {
  const savedEnv = process.env.MONITORING_ALLOW_INTERNAL;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MONITORING_ALLOW_INTERNAL;
    else process.env.MONITORING_ALLOW_INTERNAL = savedEnv;
  });

  describe('isKnownLocalSystemTarget', () => {
    it('recognises the HA and Ollama loopback endpoints', () => {
      expect(isKnownLocalSystemTarget('http://127.0.0.1:8123/')).toBe(true);
      expect(isKnownLocalSystemTarget('http://127.0.0.1:11434/')).toBe(true);
      expect(isKnownLocalSystemTarget('http://localhost:8123/')).toBe(true);
      expect(isKnownLocalSystemTarget('http://[::1]:8123/')).toBe(true);
    });

    it('rejects a loopback host on an unrecognised port', () => {
      expect(isKnownLocalSystemTarget('http://127.0.0.1:9000/')).toBe(false);
      expect(isKnownLocalSystemTarget('http://127.0.0.1/')).toBe(false); // port 80
    });

    it('rejects a known service port on a non-loopback host', () => {
      // A LAN host or public host on 8123 is NOT a self-check.
      expect(isKnownLocalSystemTarget('http://192.168.178.50:8123/')).toBe(false);
      expect(isKnownLocalSystemTarget('http://evil.example.com:8123/')).toBe(false);
    });

    it('rejects non-http(s) and malformed URLs', () => {
      expect(isKnownLocalSystemTarget('file:///etc/passwd')).toBe(false);
      expect(isKnownLocalSystemTarget('not a url')).toBe(false);
    });
  });

  describe('assertHttpTargetAllowed — systemCheck bypass (#1670)', () => {
    it('allows a system self-check of a known-local service', async () => {
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('http://127.0.0.1:8123/', { systemCheck: true }),
      ).resolves.toBeUndefined();
      await expect(
        assertHttpTargetAllowed('http://127.0.0.1:11434/', { systemCheck: true }),
      ).resolves.toBeUndefined();
    });

    it('still blocks the same loopback target when NOT a system check', async () => {
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('http://127.0.0.1:8123/'),
      ).rejects.toThrow(/Internal address blocked/);
    });

    it('still blocks a user-supplied internal (RFC1918) target even with the systemCheck flag', async () => {
      // The flag is not a blanket bypass: the target must itself be a
      // recognised loopback service. A LAN host never qualifies.
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('http://192.168.178.50:8123/', { systemCheck: true }),
      ).rejects.toThrow(/Internal address blocked/);
    });

    it('does not let systemCheck bypass an unrecognised loopback port', async () => {
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('http://127.0.0.1:9000/', { systemCheck: true }),
      ).rejects.toThrow(/Internal address blocked/);
    });
  });

  describe('assertHttpTargetAllowed — base behaviour', () => {
    it('honours MONITORING_ALLOW_INTERNAL=1 for any target', async () => {
      process.env.MONITORING_ALLOW_INTERNAL = '1';
      await expect(
        assertHttpTargetAllowed('http://127.0.0.1:9000/'),
      ).resolves.toBeUndefined();
    });

    it('rejects localhost when not allowed', async () => {
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('http://localhost:9000/'),
      ).rejects.toThrow(/Internal hostname blocked/);
    });

    it('rejects a disallowed protocol', async () => {
      delete process.env.MONITORING_ALLOW_INTERNAL;
      await expect(
        assertHttpTargetAllowed('ftp://example.com/'),
      ).rejects.toThrow(/Disallowed protocol/);
    });
  });

  describe('isPrivateAddress', () => {
    it('classifies loopback and RFC1918 as private', () => {
      expect(isPrivateAddress('127.0.0.1')).toBe(true);
      expect(isPrivateAddress('192.168.178.50')).toBe(true);
      expect(isPrivateAddress('10.0.0.1')).toBe(true);
      expect(isPrivateAddress('::1')).toBe(true);
    });

    it('classifies a public address as not private', () => {
      expect(isPrivateAddress('8.8.8.8')).toBe(false);
    });
  });
});
