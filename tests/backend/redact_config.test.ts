import { describe, it, expect } from 'vitest';
import { redactSensitiveConfig, REDACTED_SENTINEL } from '@/lib/config';

/**
 * #1275 — a scoped `sb_` API token reading GET /api/settings must never see
 * plaintext secrets. redactSensitiveConfig reuses the same SENSITIVE_KEYS set
 * as the at-rest encryption, so anything encrypted on disk is also hidden here.
 */
describe('redactSensitiveConfig (#1275)', () => {
  it('replaces every secret-keyed string with the sentinel, recursively', () => {
    const cfg = {
      serverName: 'box',
      reverseProxy: { npm: { password: 'hunter2', email: 'a@b.c' } },
      notifications: { email: { password: 'smtp-pw' } },
      apiKey: 'live-abc',
      secret: 's3cr3t',
      token: 'tok',
      key: 'kkk',
    };
    const out = redactSensitiveConfig(cfg);

    expect(out.reverseProxy.npm.password).toBe(REDACTED_SENTINEL);
    expect(out.notifications.email.password).toBe(REDACTED_SENTINEL);
    expect(out.apiKey).toBe(REDACTED_SENTINEL);
    expect(out.secret).toBe(REDACTED_SENTINEL);
    expect(out.token).toBe(REDACTED_SENTINEL);
    expect(out.key).toBe(REDACTED_SENTINEL);
    // Non-secret keys are untouched.
    expect(out.serverName).toBe('box');
    expect(out.reverseProxy.npm.email).toBe('a@b.c');
  });

  it('redacts secret-keyed values inside arrays', () => {
    const cfg = {
      installManifest: { credentials: [{ service: 'samba', password: 'p1' }, { service: 'fb', password: 'p2' }] },
    };
    const out = redactSensitiveConfig(cfg);
    expect(out.installManifest.credentials[0].password).toBe(REDACTED_SENTINEL);
    expect(out.installManifest.credentials[1].password).toBe(REDACTED_SENTINEL);
    expect(out.installManifest.credentials[0].service).toBe('samba');
  });

  it('only redacts string values, leaving non-string secret fields as-is', () => {
    const cfg = { password: 123 as unknown as string, secret: null };
    const out = redactSensitiveConfig(cfg);
    expect(out.password).toBe(123);
    expect(out.secret).toBeNull();
  });

  it('does not mutate the input (returns a deep copy)', () => {
    const cfg = { reverseProxy: { npm: { password: 'hunter2' } } };
    const out = redactSensitiveConfig(cfg);
    expect(cfg.reverseProxy.npm.password).toBe('hunter2');
    expect(out).not.toBe(cfg);
    expect(out.reverseProxy).not.toBe(cfg.reverseProxy);
  });
});
