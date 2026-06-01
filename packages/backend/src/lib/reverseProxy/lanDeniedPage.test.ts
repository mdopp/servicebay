/**
 * #1415 — branded LAN-only 403 explainer: pure builders.
 *
 * The page must be self-contained (no external assets, no backend
 * dependency), show the client IP via nginx SSI, and wire via an internal
 * SSI location that preserves the 403. The append helper must be idempotent
 * and must not clobber an existing advanced_config block.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({ agentManager: { getAgent: vi.fn() } }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));

import {
  LAN_DENIED_PAGE_HTML,
  LAN_DENIED_ADVANCED_CONFIG,
  LAN_DENIED_PAGE_CONTAINER_PATH,
  withLanDeniedPage,
} from './lanDeniedPage';

describe('LAN_DENIED_PAGE_HTML', () => {
  it('shows the client IP live via nginx SSI', () => {
    expect(LAN_DENIED_PAGE_HTML).toContain('<!--# echo var="remote_addr"');
  });

  it('is self-contained: inline <style>, no external assets, no JS', () => {
    expect(LAN_DENIED_PAGE_HTML).toContain('<style>');
    expect(LAN_DENIED_PAGE_HTML).not.toMatch(/<link[^>]+href=/i);
    expect(LAN_DENIED_PAGE_HTML).not.toMatch(/<script\b/i);
    expect(LAN_DENIED_PAGE_HTML).not.toMatch(/src=["']https?:/i);
  });

  it('uses the ServiceBay slate palette and brands the page', () => {
    expect(LAN_DENIED_PAGE_HTML).toContain('#0f172a'); // slate-900 background
    expect(LAN_DENIED_PAGE_HTML).toContain('ServiceBay');
  });

  it('orders the self-heal copy: wait/reload first, then flush, FritzBox, DoH, then LAN-only', () => {
    const waitIdx = LAN_DENIED_PAGE_HTML.indexOf('Wait about 2 minutes');
    const flushIdx = LAN_DENIED_PAGE_HTML.indexOf('ipconfig /flushdns');
    const fritzIdx = LAN_DENIED_PAGE_HTML.indexOf('FRITZ!Box');
    const dohIdx = LAN_DENIED_PAGE_HTML.indexOf('DNS-over-HTTPS');
    const lanOnlyIdx = LAN_DENIED_PAGE_HTML.indexOf('LAN-only by design');
    expect(waitIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeLessThan(flushIdx);
    expect(flushIdx).toBeLessThan(fritzIdx);
    expect(fritzIdx).toBeLessThan(dohIdx);
    expect(dohIdx).toBeLessThan(lanOnlyIdx);
  });

  it('frames it as a DNS issue, not an attack', () => {
    expect(LAN_DENIED_PAGE_HTML).toContain('not an attack');
  });
});

describe('LAN_DENIED_ADVANCED_CONFIG', () => {
  it('wires error_page 403 to an internal SSI location aliasing the shipped file', () => {
    expect(LAN_DENIED_ADVANCED_CONFIG).toContain('error_page 403');
    expect(LAN_DENIED_ADVANCED_CONFIG).toContain('internal;');
    expect(LAN_DENIED_ADVANCED_CONFIG).toContain('ssi on;');
    expect(LAN_DENIED_ADVANCED_CONFIG).toContain(`alias ${LAN_DENIED_PAGE_CONTAINER_PATH};`);
  });

  it('preserves the 403 status (no `=` rewrite on error_page)', () => {
    expect(LAN_DENIED_ADVANCED_CONFIG).not.toMatch(/error_page\s+403\s*=/);
  });
});

describe('withLanDeniedPage', () => {
  it('returns the snippet alone for an empty/undefined config', () => {
    expect(withLanDeniedPage(undefined)).toBe(LAN_DENIED_ADVANCED_CONFIG);
    expect(withLanDeniedPage('')).toBe(LAN_DENIED_ADVANCED_CONFIG);
    expect(withLanDeniedPage('   \n  ')).toBe(LAN_DENIED_ADVANCED_CONFIG);
  });

  it('appends the snippet, preserving an existing config (e.g. forward-auth)', () => {
    const existing = 'location /authelia { internal; auth_request /authelia; }';
    const out = withLanDeniedPage(existing);
    expect(out).toContain(existing);
    expect(out).toContain('error_page 403');
  });

  it('is idempotent: a config already carrying the snippet is unchanged', () => {
    const once = withLanDeniedPage('proxy_read_timeout 90;');
    const twice = withLanDeniedPage(once);
    expect(twice).toBe(once);
  });
});
