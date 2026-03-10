/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config module
const mockConfig = {
  reverseProxy: {
    publicDomain: 'example.com',
    hosts: [] as any[],
  },
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
}));

import { GET } from '../../src/app/api/auth/lldap-url/route';

describe('GET /api/auth/lldap-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.reverseProxy = { publicDomain: 'example.com', hosts: [] };
  });

  it('returns LLDAP URL when proxy host exists', async () => {
    mockConfig.reverseProxy.hosts = [
      { domain: 'ldap.example.com', service: 'lldap', forwardPort: 17170, created: true },
    ];

    const res = await GET();
    const data = await res.json();

    expect(data.url).toBe('https://ldap.example.com');
  });

  it('returns null when LLDAP proxy host not created', async () => {
    mockConfig.reverseProxy.hosts = [
      { domain: 'ldap.example.com', service: 'lldap', forwardPort: 17170, created: false },
    ];

    const res = await GET();
    const data = await res.json();

    expect(data.url).toBeNull();
  });

  it('returns null when no LLDAP host exists', async () => {
    mockConfig.reverseProxy.hosts = [
      { domain: 'vault.example.com', service: 'vaultwarden', forwardPort: 8080, created: true },
    ];

    const res = await GET();
    const data = await res.json();

    expect(data.url).toBeNull();
  });

  it('returns null when hosts array is empty', async () => {
    mockConfig.reverseProxy.hosts = [];

    const res = await GET();
    const data = await res.json();

    expect(data.url).toBeNull();
  });

  it('returns null when reverseProxy config is missing', async () => {
    (mockConfig as any).reverseProxy = undefined;

    const res = await GET();
    const data = await res.json();

    expect(data.url).toBeNull();
  });
});
