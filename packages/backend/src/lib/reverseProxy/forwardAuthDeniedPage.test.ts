/**
 * #1684 — forward-auth (Authelia authorization deny) 403 explainer: pure builders.
 *
 * A forward-auth host's 403 means "you ARE signed in, but you're not in the
 * group this service requires" — NOT the LAN-only deny (#1415) or a bare
 * upstream error (#1583). The explainer must name WHAT'S REQUIRED (the group
 * derived from the domain's Authelia access_control rule) and WHO the user is
 * (signed-in $user / $groups, echoed via SSI), and the page/wiring must be
 * distinct from the LAN-only path so the three branches don't collide.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({ agentManager: { getAgent: vi.fn() } }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));

import {
  requiredGroupsForDomain,
  buildForwardAuthDeniedPageHtml,
  withForwardAuthDeniedPage,
  forwardAuthDeniedAdvancedConfig,
  forwardAuthDeniedContainerPath,
  forwardAuthDeniedHostPath,
  // for the cross-branch distinction assertions:
  LAN_DENIED_PAGE_HTML,
  withLanDeniedPage,
} from './lanDeniedPage';

describe('requiredGroupsForDomain', () => {
  it('maps the admin-only subdomains to the admins group', () => {
    for (const d of ['admin.dopp.cloud', 'nginx.dopp.cloud', 'dns.dopp.cloud', 'ldap.dopp.cloud']) {
      expect(requiredGroupsForDomain(d)).toEqual(['admins']);
    }
  });

  it('maps everything else to family or admins (the wildcard rule)', () => {
    expect(requiredGroupsForDomain('ollama.dopp.cloud')).toEqual(['family', 'admins']);
    expect(requiredGroupsForDomain('photos.dopp.cloud')).toEqual(['family', 'admins']);
  });

  it('inspects only the leftmost label and is case-insensitive', () => {
    expect(requiredGroupsForDomain('LDAP.dopp.cloud')).toEqual(['admins']);
    expect(requiredGroupsForDomain('ldap')).toEqual(['admins']);
  });

  it('defaults an empty/undefined domain to the wildcard groups', () => {
    expect(requiredGroupsForDomain(undefined)).toEqual(['family', 'admins']);
    expect(requiredGroupsForDomain('')).toEqual(['family', 'admins']);
  });
});

describe('buildForwardAuthDeniedPageHtml — auth-deny branch', () => {
  it('names the required group AND the signed-in identity (the acceptance)', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    // WHAT'S REQUIRED — the wildcard rule's groups for a non-admin host.
    expect(html).toContain('<code>family</code>');
    expect(html).toContain('<code>admins</code>');
    expect(html).toContain('ollama.dopp.cloud');
    // WHO YOU ARE — live signed-in identity via nginx SSI.
    expect(html).toContain('<!--# echo var="user"');
    expect(html).toContain('<!--# echo var="groups"');
    expect(html).toMatch(/signed in as/i);
  });

  it('names only admins for an admin-only host', () => {
    const html = buildForwardAuthDeniedPageHtml('ldap.dopp.cloud', 'dopp.cloud');
    expect(html).toContain('<code>admins</code>');
    expect(html).not.toContain('<code>family</code>');
  });

  it('points at signing out via auth.<publicDomain> when given a domain', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    expect(html).toContain('https://auth.dopp.cloud');
  });

  it('omits the auth link cleanly when no public domain is known', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud');
    expect(html).not.toContain('href="https://auth.');
    // still names the requirement + identity.
    expect(html).toContain('ollama.dopp.cloud');
    expect(html).toContain('<!--# echo var="user"');
  });

  it('is self-contained: inline <style>, no external assets, no JS', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/src=["']https?:/i);
  });

  it('brands as ServiceBay in the shared slate palette', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    expect(html).toContain('ServiceBay');
    expect(html).toContain('#0f172a');
  });

  it('frames it as a permission problem, NOT a network/DNS problem (vs LAN-only)', () => {
    const html = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    expect(html).toMatch(/isn't a network or DNS problem/i);
    // The LAN-only page's DNS self-heal copy must NOT appear here.
    expect(html).not.toContain('ipconfig /flushdns');
    expect(html).not.toContain('LAN-only by design');
  });
});

describe('the three 403 branches are distinct', () => {
  it('auth-deny vs LAN-only render different pages', () => {
    const authDeny = buildForwardAuthDeniedPageHtml('ollama.dopp.cloud', 'dopp.cloud');
    // LAN-only is about stale DNS + the client IP; auth-deny is about groups.
    expect(LAN_DENIED_PAGE_HTML).toContain('remote_addr');
    expect(LAN_DENIED_PAGE_HTML).not.toContain('<!--# echo var="groups"');
    expect(authDeny).not.toContain('remote_addr');
    expect(authDeny).toContain('<!--# echo var="groups"');
  });

  it('the LAN-only and forward-auth error_page snippets alias different files', () => {
    const lan = withLanDeniedPage('');
    const fa = forwardAuthDeniedAdvancedConfig('ollama.dopp.cloud');
    expect(lan).toContain('servicebay-lan-only');
    expect(fa).toContain('servicebay-forward-auth-denied');
    expect(lan).not.toContain('forward-auth-denied');
    expect(fa).not.toContain('servicebay-lan-only');
  });
});

describe('forwardAuthDeniedAdvancedConfig', () => {
  it('wires error_page 403 to an internal SSI location aliasing the host file', () => {
    const cfg = forwardAuthDeniedAdvancedConfig('ollama.dopp.cloud');
    expect(cfg).toContain('error_page 403');
    expect(cfg).toContain('internal;');
    expect(cfg).toContain('ssi on;');
    expect(cfg).toContain(`alias ${forwardAuthDeniedContainerPath('ollama.dopp.cloud')};`);
  });

  it('preserves the 403 status (no `=` rewrite on error_page)', () => {
    expect(forwardAuthDeniedAdvancedConfig('ollama.dopp.cloud')).not.toMatch(/error_page\s+403\s*=/);
  });

  it('aliases a per-host file slugged by domain', () => {
    expect(forwardAuthDeniedContainerPath('ollama.dopp.cloud')).toContain('forward-auth-denied-ollama.dopp.cloud.html');
    expect(forwardAuthDeniedHostPath('ldap.dopp.cloud')).toContain('forward-auth-denied-ldap.dopp.cloud.html');
    // different hosts → different files (no clobber).
    expect(forwardAuthDeniedContainerPath('a.dopp.cloud')).not.toBe(forwardAuthDeniedContainerPath('b.dopp.cloud'));
  });
});

describe('withForwardAuthDeniedPage', () => {
  it('returns the host snippet alone for an empty/undefined config', () => {
    expect(withForwardAuthDeniedPage(undefined, 'ollama.dopp.cloud')).toBe(
      forwardAuthDeniedAdvancedConfig('ollama.dopp.cloud'),
    );
    expect(withForwardAuthDeniedPage('   \n  ', 'ollama.dopp.cloud')).toBe(
      forwardAuthDeniedAdvancedConfig('ollama.dopp.cloud'),
    );
  });

  it('appends the snippet, preserving an existing forward-auth config', () => {
    const existing = 'auth_request /authelia;\nlocation = /authelia { internal; }';
    const out = withForwardAuthDeniedPage(existing, 'ollama.dopp.cloud');
    expect(out).toContain(existing);
    expect(out).toContain('error_page 403');
  });

  it('is idempotent: a config already carrying the snippet is unchanged', () => {
    const once = withForwardAuthDeniedPage('proxy_read_timeout 90;', 'ollama.dopp.cloud');
    const twice = withForwardAuthDeniedPage(once, 'ollama.dopp.cloud');
    expect(twice).toBe(once);
  });
});
