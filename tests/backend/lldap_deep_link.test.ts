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

import { getLldapUserDeepLink } from '../../src/lib/lldap/client';

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
});
