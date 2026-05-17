/**
 * Schema tests for the POST /api/settings validation gate (#595).
 *
 * Pins the contract that the route's `AppConfigPartialSchema.safeParse`
 * actually rejects the two problem shapes the issue flagged:
 *   - unknown top-level keys (typos like `servername` vs `serverName`)
 *   - wrong-typed values on tightly-defined primitives
 */

import { describe, it, expect } from 'vitest';
import { AppConfigPartialSchema, formatConfigErrors } from '../../src/lib/config/schema';

describe('AppConfigPartialSchema (#595)', () => {
  it('accepts a partial valid config (the common UI save-section case)', () => {
    const r = AppConfigPartialSchema.safeParse({
      serverName: 'home-server',
      logLevel: 'info',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty body (no-op save)', () => {
    const r = AppConfigPartialSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('rejects an unknown top-level key (typo guard)', () => {
    const r = AppConfigPartialSchema.safeParse({ servername: 'oops-typo' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const errors = formatConfigErrors(r.error);
    expect(errors.some(e => /servername/i.test(e))).toBe(true);
  });

  it('rejects a wrong-typed primitive', () => {
    const r = AppConfigPartialSchema.safeParse({ serverName: 12345 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const errors = formatConfigErrors(r.error);
    expect(errors.some(e => /serverName/.test(e))).toBe(true);
  });

  it('rejects an invalid logLevel enum value', () => {
    const r = AppConfigPartialSchema.safeParse({ logLevel: 'verbose' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-boolean for setupCompleted', () => {
    const r = AppConfigPartialSchema.safeParse({ setupCompleted: 'yes' });
    expect(r.success).toBe(false);
  });

  it('accepts complex nested objects via the passthrough escape hatch', () => {
    const r = AppConfigPartialSchema.safeParse({
      gateway: { type: 'fritzbox', host: 'fritz.box', port: 49000 },
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.1.10' },
      notifications: { email: { enabled: false } },
    });
    expect(r.success).toBe(true);
  });

  it('rejects templateSettings whose values are not strings', () => {
    const r = AppConfigPartialSchema.safeParse({
      templateSettings: { DATA_DIR: 12345 },
    });
    expect(r.success).toBe(false);
  });

  it('formatConfigErrors produces readable path-prefixed messages', () => {
    const r = AppConfigPartialSchema.safeParse({ serverName: 12345 });
    if (r.success) throw new Error('expected failure');
    const errors = formatConfigErrors(r.error);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).toMatch(/^[\w.<>]+:\s/);
    }
  });
});
