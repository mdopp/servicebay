/**
 * #1583 — branded proxy error pages: pure builders.
 *
 * Two dead-ends generalise the #1415 mechanism: an unknown subdomain (default
 * server) and a bare 401/502/504 on a configured host. Both pages must be
 * self-contained, brand as ServiceBay, and point at a next step. The wiring
 * snippets must alias the shipped files and preserve the original status, and
 * the per-host append helper must be idempotent and non-clobbering.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({ agentManager: { getAgent: vi.fn() } }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));

import {
  buildUnknownHostPageHtml,
  buildProxyErrorPageHtml,
  withProxyErrorPage,
  DEAD_HOST_CUSTOM_CONF,
  PROXY_ERROR_ADVANCED_CONFIG,
  UNKNOWN_HOST_PAGE_CONTAINER_PATH,
  PROXY_ERROR_PAGE_CONTAINER_PATH,
} from './proxyErrorPages';

function assertSelfContained(html: string) {
  expect(html).toContain('<style>');
  expect(html).not.toMatch(/<link[^>]+href=/i);
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/src=["']https?:/i);
}

describe('buildUnknownHostPageHtml', () => {
  it('brands the page and explains the host is not a configured service', () => {
    const html = buildUnknownHostPageHtml('dopp.cloud');
    expect(html).toContain('ServiceBay');
    expect(html).toContain('#0f172a'); // slate palette, matches #1415
    expect(html).toMatch(/isn't set up here|isn&#39;t set up here|configured/i);
  });

  it('is self-contained: inline <style>, no external assets, no JS', () => {
    assertSelfContained(buildUnknownHostPageHtml('dopp.cloud'));
  });

  it('links the dashboard and suggests checking spelling / AdGuard rewrites', () => {
    const html = buildUnknownHostPageHtml('dopp.cloud');
    expect(html).toContain('https://dopp.cloud');
    expect(html).toMatch(/spelling/i);
    expect(html).toMatch(/AdGuard/i);
  });

  it('degrades gracefully with no domain (no URL, generic dashboard wording)', () => {
    const html = buildUnknownHostPageHtml();
    expect(html).not.toMatch(/href="https:\/\//);
    expect(html).toContain('your ServiceBay dashboard');
  });

  it('normalises a domain passed with scheme / trailing slash', () => {
    const html = buildUnknownHostPageHtml('https://dopp.cloud/');
    expect(html).toContain('https://dopp.cloud<');
    expect(html).not.toContain('https://https://');
  });
});

describe('buildProxyErrorPageHtml', () => {
  it('brands the page and shows the live status via nginx SSI', () => {
    const html = buildProxyErrorPageHtml('dopp.cloud');
    expect(html).toContain('ServiceBay');
    expect(html).toContain('<!--# echo var="status"');
  });

  it('is self-contained: inline <style>, no external assets, no JS', () => {
    assertSelfContained(buildProxyErrorPageHtml('dopp.cloud'));
  });

  it('points 401 at the auth portal and 502/504 at "starting/offline"', () => {
    const html = buildProxyErrorPageHtml('dopp.cloud');
    expect(html).toContain('https://auth.dopp.cloud');
    expect(html).toMatch(/starting or offline|502\/503\/504/i);
  });

  it('degrades the sign-in hint with no domain', () => {
    const html = buildProxyErrorPageHtml();
    expect(html).not.toMatch(/href="https:\/\//);
    expect(html).toMatch(/login page/i);
  });
});

describe('DEAD_HOST_CUSTOM_CONF (default/dead-host server include)', () => {
  it('re-routes the catch-all errors to the unknown-host page via an internal alias', () => {
    expect(DEAD_HOST_CUSTOM_CONF).toContain('error_page');
    expect(DEAD_HOST_CUSTOM_CONF).toContain('internal;');
    expect(DEAD_HOST_CUSTOM_CONF).toContain(`alias ${UNKNOWN_HOST_PAGE_CONTAINER_PATH};`);
  });

  it('covers the bare codes the default server can emit (401/404 included)', () => {
    expect(DEAD_HOST_CUSTOM_CONF).toMatch(/error_page[^;]*\b401\b/);
    expect(DEAD_HOST_CUSTOM_CONF).toMatch(/error_page[^;]*\b404\b/);
  });

  it('preserves the original status (no `=` rewrite on error_page)', () => {
    expect(DEAD_HOST_CUSTOM_CONF).not.toMatch(/error_page\s+[\d\s]*=/);
  });
});

describe('PROXY_ERROR_ADVANCED_CONFIG (per-configured-host snippet)', () => {
  it('wires 401/502/504 to an internal SSI location aliasing the shipped file', () => {
    expect(PROXY_ERROR_ADVANCED_CONFIG).toMatch(/error_page[^;]*\b401\b/);
    expect(PROXY_ERROR_ADVANCED_CONFIG).toMatch(/error_page[^;]*\b502\b/);
    expect(PROXY_ERROR_ADVANCED_CONFIG).toMatch(/error_page[^;]*\b504\b/);
    expect(PROXY_ERROR_ADVANCED_CONFIG).toContain('ssi on;');
    expect(PROXY_ERROR_ADVANCED_CONFIG).toContain(`alias ${PROXY_ERROR_PAGE_CONTAINER_PATH};`);
  });

  it('does NOT claim 403 (that is the #1415 LAN-denied path)', () => {
    expect(PROXY_ERROR_ADVANCED_CONFIG).not.toMatch(/error_page[^;]*\b403\b/);
  });
});

describe('withProxyErrorPage', () => {
  it('returns the snippet alone for an empty/undefined config', () => {
    expect(withProxyErrorPage(undefined)).toBe(PROXY_ERROR_ADVANCED_CONFIG);
    expect(withProxyErrorPage('')).toBe(PROXY_ERROR_ADVANCED_CONFIG);
    expect(withProxyErrorPage('   \n  ')).toBe(PROXY_ERROR_ADVANCED_CONFIG);
  });

  it('appends, preserving an existing config (e.g. the #1415 LAN-denied block)', () => {
    const existing = 'error_page 403 /servicebay-lan-only;';
    const out = withProxyErrorPage(existing);
    expect(out).toContain(existing);
    expect(out).toMatch(/error_page[^;]*\b401\b/);
  });

  it('is idempotent: a config already carrying the snippet is unchanged', () => {
    const once = withProxyErrorPage('proxy_read_timeout 90;');
    const twice = withProxyErrorPage(once);
    expect(twice).toBe(once);
  });
});
