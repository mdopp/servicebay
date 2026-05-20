/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Regression coverage for #442: after access-request approval, the admin
 * redirect must point at the NPM-exposed LLDAP subdomain (e.g.
 * `https://ldap.example.com/user/<id>`), not the internal
 * `http://localhost:17170` URL that `templates/auth/post-deploy.py`
 * persists under `config.lldap.url` for in-process API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig: {
  lldap?: { url?: string; username?: string; password?: string };
  reverseProxy?: { hosts?: any[] };
} = {};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
}));

import { getLldapUserDeepLink } from '@/lib/lldap/client';

describe('getLldapUserDeepLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete mockConfig.lldap;
    delete mockConfig.reverseProxy;
  });

  it('prefers the NPM-exposed subdomain over config.lldap.url', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170', username: 'admin', password: 'x' };
    mockConfig.reverseProxy = {
      hosts: [{ domain: 'ldap.example.com', service: 'lldap', forwardPort: 17170, created: true }],
    };

    const link = await getLldapUserDeepLink('alice');
    expect(link).toBe('https://ldap.example.com/user/alice');
  });

  it('ignores LLDAP host entries that are not yet created', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170' };
    mockConfig.reverseProxy = {
      hosts: [{ domain: 'ldap.example.com', service: 'lldap', forwardPort: 17170, created: false }],
    };

    const link = await getLldapUserDeepLink('alice');
    expect(link).toBe('http://localhost:17170/user/alice');
  });

  it('falls back to config.lldap.url when no proxy host exists (LAN-only install)', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170' };
    mockConfig.reverseProxy = { hosts: [] };

    const link = await getLldapUserDeepLink('alice');
    expect(link).toBe('http://localhost:17170/user/alice');
  });

  it('encodes user IDs containing special characters', async () => {
    mockConfig.reverseProxy = {
      hosts: [{ domain: 'ldap.example.com', service: 'lldap', forwardPort: 17170, created: true }],
    };

    const link = await getLldapUserDeepLink('a b/c');
    expect(link).toBe('https://ldap.example.com/user/a%20b%2Fc');
  });

  it('returns null when neither a proxy host nor lldap.url is set', async () => {
    const link = await getLldapUserDeepLink('alice');
    expect(link).toBeNull();
  });

  it('does not match unrelated services even if domain looks LDAP-y', async () => {
    mockConfig.reverseProxy = {
      hosts: [{ domain: 'ldap.example.com', service: 'authelia', forwardPort: 9091, created: true }],
    };

    const link = await getLldapUserDeepLink('alice');
    expect(link).toBeNull();
  });

  // Real-world regression: the `auth` template owns both
  // LLDAP_SUBDOMAIN and AUTHELIA_SUBDOMAIN, so buildProxyHosts
  // writes `service: 'auth'` on both (via meta.templateName injected
  // by useStackInstall.ts). The pre-fix lookup matched on
  // `service === 'lldap'`, never hit, and silently fell back to
  // `http://localhost:17170`. We now discriminate by port instead.
  it('matches the LLDAP host by forwardPort when service is the template name "auth"', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170', username: 'admin', password: 'x' };
    mockConfig.reverseProxy = {
      hosts: [
        { domain: 'ldap.dopp.cloud', service: 'auth', forwardPort: 17170, created: true },
        { domain: 'auth.dopp.cloud', service: 'auth', forwardPort: 9091, created: true },
      ],
    };

    const link = await getLldapUserDeepLink('mdopp');
    expect(link).toBe('https://ldap.dopp.cloud/user/mdopp');
  });

  it('picks the LLDAP host, not the Authelia host, when both share service=auth', async () => {
    // Order shouldn't matter — port match wins regardless of which entry
    // appears first in hosts[].
    mockConfig.lldap = { url: 'http://localhost:17170', username: 'admin', password: 'x' };
    mockConfig.reverseProxy = {
      hosts: [
        { domain: 'auth.dopp.cloud', service: 'auth', forwardPort: 9091, created: true },
        { domain: 'ldap.dopp.cloud', service: 'auth', forwardPort: 17170, created: true },
      ],
    };

    const link = await getLldapUserDeepLink('mdopp');
    expect(link).toBe('https://ldap.dopp.cloud/user/mdopp');
  });

  it('honours a non-default LLDAP port via config.lldap.url', async () => {
    mockConfig.lldap = { url: 'http://localhost:18888' };
    mockConfig.reverseProxy = {
      hosts: [
        { domain: 'ldap.dopp.cloud', service: 'auth', forwardPort: 18888, created: true },
      ],
    };

    const link = await getLldapUserDeepLink('mdopp');
    expect(link).toBe('https://ldap.dopp.cloud/user/mdopp');
  });

  it('falls back to http for pure LAN-only domains (home.arpa) with no wildcard cert', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170' };
    mockConfig.reverseProxy = {
      hosts: [
        { domain: 'ldap.home.arpa', service: 'auth', forwardPort: 17170, created: true },
      ],
    };

    const link = await getLldapUserDeepLink('mdopp');
    // .home.arpa has no LE cert; https would fail in the browser.
    expect(link).toBe('http://ldap.home.arpa/user/mdopp');
  });

  it('returns null when only an Authelia host is created (no LLDAP entry to point at)', async () => {
    mockConfig.lldap = { url: 'http://localhost:17170' };
    mockConfig.reverseProxy = {
      hosts: [
        { domain: 'auth.dopp.cloud', service: 'auth', forwardPort: 9091, created: true },
      ],
    };

    // No host whose forwardPort = 17170; lldap.url fallback works.
    const link = await getLldapUserDeepLink('mdopp');
    expect(link).toBe('http://localhost:17170/user/mdopp');
  });
});
