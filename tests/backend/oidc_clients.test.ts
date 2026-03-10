/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mocks ---

const mockAgent = {
  sendCommand: vi.fn(),
};

vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    ensureAgent: vi.fn(() => Promise.resolve(mockAgent)),
  },
}));

const mockServiceFiles: Record<string, any> = {};

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    getServiceFiles: vi.fn((node: string, service: string) => {
      const key = `${node}:${service}`;
      if (mockServiceFiles[key]) return Promise.resolve(mockServiceFiles[key]);
      return Promise.reject(new Error('Not found'));
    }),
    restartService: vi.fn(() => Promise.resolve()),
  },
}));

const mockNodes: Record<string, any> = {};

vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({
      nodes: mockNodes,
    }),
  },
}));

const mockTemplateVariables: Record<string, any> = {};

vi.mock('@/lib/registry', () => ({
  getTemplateVariables: vi.fn((name: string, source?: string) => {
    const key = source ? `${source}:${name}` : name;
    return Promise.resolve(mockTemplateVariables[key] || mockTemplateVariables[name] || null);
  }),
}));

import { POST } from '../../src/app/api/system/authelia/oidc-clients/route';

// Minimal Authelia pod YAML with a config volume
const AUTHELIA_YAML = `
apiVersion: v1
kind: Pod
metadata:
  name: authelia
spec:
  containers:
    - name: authelia
      image: authelia/authelia
  volumes:
    - name: authelia-config
      hostPath:
        path: /data/authelia/config
`;

// Minimal Authelia configuration.yml with no existing clients
const AUTHELIA_CONFIG_EMPTY = `
server:
  address: 'tcp://:9091'
identity_providers:
  oidc:
    clients: []
`;

// Authelia config with an existing client
const AUTHELIA_CONFIG_WITH_CLIENT = `
server:
  address: 'tcp://:9091'
identity_providers:
  oidc:
    clients:
      - client_id: immich
        client_name: Immich
        client_secret: '$plaintext$existing-secret'
        redirect_uris:
          - 'https://photos.example.com/auth/login'
`;

function createPostRequest(body: any): NextRequest {
  return new NextRequest('http://localhost/api/system/authelia/oidc-clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/system/authelia/oidc-clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear mock state
    Object.keys(mockServiceFiles).forEach(k => delete mockServiceFiles[k]);
    Object.keys(mockNodes).forEach(k => delete mockNodes[k]);
    Object.keys(mockTemplateVariables).forEach(k => delete mockTemplateVariables[k]);
  });

  it('returns 400 when templates missing', async () => {
    const req = createPostRequest({ variables: { PUBLIC_DOMAIN: 'example.com' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when variables missing', async () => {
    const req = createPostRequest({ templates: [{ name: 'immich' }] });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when PUBLIC_DOMAIN not set', async () => {
    const req = createPostRequest({
      templates: [{ name: 'immich' }],
      variables: { IMMICH_SUBDOMAIN: 'photos' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when Authelia is not deployed', async () => {
    mockNodes['node1'] = {};
    mockTemplateVariables['immich'] = {
      IMMICH_SUBDOMAIN: {
        type: 'subdomain',
        oidcClient: {
          client_id: 'immich',
          client_name: 'Immich',
          redirect_uris: ['/auth/login'],
        },
      },
    };

    const req = createPostRequest({
      templates: [{ name: 'immich' }],
      variables: { PUBLIC_DOMAIN: 'example.com', IMMICH_SUBDOMAIN: 'photos' },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not deployed');
  });

  it('extracts OIDC clients from template variables and registers them', async () => {
    // Setup: Authelia deployed on node1
    mockNodes['node1'] = {};
    mockServiceFiles['node1:authelia'] = { yamlContent: AUTHELIA_YAML };
    mockAgent.sendCommand.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve({ content: AUTHELIA_CONFIG_EMPTY });
      if (cmd === 'write_file') return Promise.resolve({});
      return Promise.resolve({});
    });

    // Template has OIDC client metadata
    mockTemplateVariables['immich'] = {
      IMMICH_SUBDOMAIN: {
        type: 'subdomain',
        proxyPort: '2283',
        oidcClient: {
          client_id: 'immich',
          client_name: 'Immich',
          authorization_policy: 'one_factor',
          redirect_uris: ['/auth/login', '/user-settings', 'app.immich:/'],
          scopes: ['openid', 'profile', 'email'],
        },
      },
    };

    const req = createPostRequest({
      templates: [{ name: 'immich' }],
      variables: { PUBLIC_DOMAIN: 'example.com', IMMICH_SUBDOMAIN: 'photos' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.added).toEqual(['immich']);
    expect(data.skipped).toEqual([]);

    // Verify the config was written with the new client
    const writeCall = mockAgent.sendCommand.mock.calls.find((c: any) => c[0] === 'write_file');
    expect(writeCall).toBeDefined();
    const writtenContent = writeCall[1].content;
    expect(writtenContent).toContain('client_id: immich');
    expect(writtenContent).toContain('https://photos.example.com/auth/login');
    expect(writtenContent).toContain('https://photos.example.com/user-settings');
    // app.immich:/ is absolute, should not be prefixed
    expect(writtenContent).toContain('app.immich:/');
  });

  it('skips already registered clients', async () => {
    mockNodes['node1'] = {};
    mockServiceFiles['node1:authelia'] = { yamlContent: AUTHELIA_YAML };
    mockAgent.sendCommand.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve({ content: AUTHELIA_CONFIG_WITH_CLIENT });
      if (cmd === 'write_file') return Promise.resolve({});
      return Promise.resolve({});
    });

    mockTemplateVariables['immich'] = {
      IMMICH_SUBDOMAIN: {
        type: 'subdomain',
        oidcClient: {
          client_id: 'immich',
          client_name: 'Immich',
          redirect_uris: ['/auth/login'],
        },
      },
    };

    const req = createPostRequest({
      templates: [{ name: 'immich' }],
      variables: { PUBLIC_DOMAIN: 'example.com', IMMICH_SUBDOMAIN: 'photos' },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.added).toEqual([]);
    expect(data.skipped).toEqual(['immich']);
    // Should not write config if nothing was added
    const writeCall = mockAgent.sendCommand.mock.calls.find((c: any) => c[0] === 'write_file');
    expect(writeCall).toBeUndefined();
  });

  it('handles multiple templates with mixed OIDC/non-OIDC variables', async () => {
    mockNodes['node1'] = {};
    mockServiceFiles['node1:authelia'] = { yamlContent: AUTHELIA_YAML };
    mockAgent.sendCommand.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve({ content: AUTHELIA_CONFIG_EMPTY });
      if (cmd === 'write_file') return Promise.resolve({});
      return Promise.resolve({});
    });

    // immich has OIDC, adguard does not
    mockTemplateVariables['immich'] = {
      IMMICH_SUBDOMAIN: {
        type: 'subdomain',
        oidcClient: {
          client_id: 'immich',
          client_name: 'Immich',
          redirect_uris: ['/auth/login'],
        },
      },
    };
    mockTemplateVariables['adguard'] = {
      DNS_SUBDOMAIN: {
        type: 'subdomain',
        proxyPort: '3000',
      },
    };

    const req = createPostRequest({
      templates: [{ name: 'immich' }, { name: 'adguard' }],
      variables: {
        PUBLIC_DOMAIN: 'example.com',
        IMMICH_SUBDOMAIN: 'photos',
        DNS_SUBDOMAIN: 'dns',
      },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.added).toEqual(['immich']);
  });

  it('returns empty result when no templates have OIDC clients', async () => {
    mockTemplateVariables['adguard'] = {
      DNS_SUBDOMAIN: { type: 'subdomain', proxyPort: '3000' },
    };

    const req = createPostRequest({
      templates: [{ name: 'adguard' }],
      variables: { PUBLIC_DOMAIN: 'example.com', DNS_SUBDOMAIN: 'dns' },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.added).toEqual([]);
    expect(data.message).toContain('No OIDC clients found');
  });

  it('skips subdomain variables without a value', async () => {
    mockTemplateVariables['immich'] = {
      IMMICH_SUBDOMAIN: {
        type: 'subdomain',
        oidcClient: {
          client_id: 'immich',
          client_name: 'Immich',
          redirect_uris: ['/auth/login'],
        },
      },
    };

    const req = createPostRequest({
      templates: [{ name: 'immich' }],
      variables: { PUBLIC_DOMAIN: 'example.com', IMMICH_SUBDOMAIN: '' },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.added).toEqual([]);
    expect(data.message).toContain('No OIDC clients found');
  });
});
