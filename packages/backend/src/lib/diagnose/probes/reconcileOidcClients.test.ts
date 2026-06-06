/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ADR 0009 Phase 2 (#1741) — `sso_verify` `reconcile_oidc_clients` heal-action.
 *
 * Covers the payload builder (config + template-meta → templates[]/variables map)
 * and the dispatch path (internalFetch contract, added/skipped diff surfacing,
 * 404/error handling). The reconcile-first secret guarantee lives in the POST
 * route (#1738, resolveOidcClientSecret.test.ts) — here we only assert the
 * action wires installed templates through that path without regenerating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConfig: any = {};
const getTemplateVariablesMock = vi.fn();

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
}));
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: (...args: unknown[]) => getTemplateVariablesMock(...args),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn() },
}));

import { dispatchProbeAction } from '../actions';
import { buildOidcReconcilePayload } from '@/lib/capabilities/authelia';
import './oidcProviderReachable';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const OIDC_META = {
  IMMICH_SUBDOMAIN: {
    type: 'subdomain',
    default: 'photos',
    oidcClient: { client_id: 'immich', client_name: 'Immich' },
  },
};
const NO_OIDC_META = {
  FOO_SUBDOMAIN: { type: 'subdomain', default: 'foo' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockConfig = {};
  getTemplateVariablesMock.mockReset();
  fetchSpy.mockReset();
});

describe('buildOidcReconcilePayload', () => {
  it('returns null when no public domain is configured', async () => {
    const payload = await buildOidcReconcilePayload({
      installedTemplates: ['immich'],
      publicDomain: undefined,
    });
    expect(payload).toBeNull();
    expect(getTemplateVariablesMock).not.toHaveBeenCalled();
  });

  it('returns null when no installed template declares an OIDC client', async () => {
    getTemplateVariablesMock.mockResolvedValue(NO_OIDC_META);
    const payload = await buildOidcReconcilePayload({
      installedTemplates: ['media'],
      publicDomain: 'dopp.cloud',
    });
    expect(payload).toBeNull();
  });

  it('builds templates[] + variables from installed OIDC templates', async () => {
    getTemplateVariablesMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'immich' ? OIDC_META : NO_OIDC_META),
    );
    const payload = await buildOidcReconcilePayload({
      installedTemplates: ['immich', 'media'],
      publicDomain: 'dopp.cloud',
    });
    expect(payload).toEqual({
      templates: [{ name: 'immich' }],
      variables: { PUBLIC_DOMAIN: 'dopp.cloud', IMMICH_SUBDOMAIN: 'photos' },
    });
  });

  it('tolerates a template whose meta fails to load', async () => {
    getTemplateVariablesMock.mockImplementation((name: string) =>
      name === 'immich' ? Promise.resolve(OIDC_META) : Promise.reject(new Error('no disk')),
    );
    const payload = await buildOidcReconcilePayload({
      installedTemplates: ['immich', 'broken'],
      publicDomain: 'dopp.cloud',
    });
    expect(payload?.templates).toEqual([{ name: 'immich' }]);
  });
});

describe('sso_verify.reconcile_oidc_clients action', () => {
  it('short-circuits with ok when there is nothing to reconcile', async () => {
    mockConfig = { installedTemplates: {}, reverseProxy: {} };
    const result = await dispatchProbeAction({
      probeId: 'sso_verify',
      actionId: 'reconcile_oidc_clients',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/nothing to reconcile/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs installed OIDC templates and surfaces the add/skip diff', async () => {
    mockConfig = {
      installedTemplates: { immich: { schemaVersion: 1, installedAt: 'x' } },
      reverseProxy: { publicDomain: 'dopp.cloud' },
    };
    getTemplateVariablesMock.mockResolvedValue(OIDC_META);
    fetchSpy.mockResolvedValue(jsonResponse(200, { added: ['immich'], skipped: ['vaultwarden'] }));

    const result = await dispatchProbeAction({
      probeId: 'sso_verify',
      actionId: 'reconcile_oidc_clients',
      node: 'Local',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/system/authelia/oidc-clients');
    expect((init as RequestInit).method).toBe('POST');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.templates).toEqual([{ name: 'immich' }]);
    expect(sentBody.variables.PUBLIC_DOMAIN).toBe('dopp.cloud');

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Registered 1 OIDC client/);
    expect(result.details).toContain('added: immich');
    expect(result.details).toContain('skipped: vaultwarden');
    expect(result.refresh).toBe(true);
  });

  it('reports no-change when every client is already registered', async () => {
    mockConfig = {
      installedTemplates: { immich: { schemaVersion: 1, installedAt: 'x' } },
      reverseProxy: { publicDomain: 'dopp.cloud' },
    };
    getTemplateVariablesMock.mockResolvedValue(OIDC_META);
    fetchSpy.mockResolvedValue(jsonResponse(200, { added: [], skipped: ['immich'] }));

    const result = await dispatchProbeAction({
      probeId: 'sso_verify',
      actionId: 'reconcile_oidc_clients',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already registered/i);
  });

  it('fails clearly when Authelia is not deployed (404)', async () => {
    mockConfig = {
      installedTemplates: { immich: { schemaVersion: 1, installedAt: 'x' } },
      reverseProxy: { publicDomain: 'dopp.cloud' },
    };
    getTemplateVariablesMock.mockResolvedValue(OIDC_META);
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'Authelia is not deployed' }));

    const result = await dispatchProbeAction({
      probeId: 'sso_verify',
      actionId: 'reconcile_oidc_clients',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not deployed/i);
    expect(result.refresh).toBe(false);
  });

  it('surfaces a server error without masking it as success', async () => {
    mockConfig = {
      installedTemplates: { immich: { schemaVersion: 1, installedAt: 'x' } },
      reverseProxy: { publicDomain: 'dopp.cloud' },
    };
    getTemplateVariablesMock.mockResolvedValue(OIDC_META);
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'write_file EACCES' }));

    const result = await dispatchProbeAction({
      probeId: 'sso_verify',
      actionId: 'reconcile_oidc_clients',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/EACCES/);
  });
});
