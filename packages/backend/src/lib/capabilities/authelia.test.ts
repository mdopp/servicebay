/**
 * Authelia capability handler tests (#630).
 *
 * Drives the handler directly with mocked `fetch` + mocked
 * `getTemplateVariables`. The bus is irrelevant here — the contract we
 * care about is "handler returns the right `HandlerResult` for the
 * remote-side response."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTemplateVariablesMock = vi.fn();
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: (...args: unknown[]) => getTemplateVariablesMock(...args),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));

import { handleInstalled, handleUninstalled } from './authelia';
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const MANIFEST: TemplateManifest = {
  label: 'Test', tier: 'feature', schemaVersion: 1, dependencies: [],
};

const VARS_PUBLIC: StackVariable[] = [
  { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
  { name: 'IMMICH_SUBDOMAIN', value: 'photos', meta: { type: 'subdomain' } as StackVariable['meta'] },
];

const META_WITH_OIDC = {
  IMMICH_SUBDOMAIN: {
    type: 'subdomain',
    oidcClient: {
      client_id: 'immich',
      client_name: 'Immich',
      authorization_policy: 'one_factor',
      redirect_uris: ['/auth/login'],
      scopes: ['openid', 'profile', 'email'],
    },
  },
};

const META_NO_OIDC = {
  IMMICH_SUBDOMAIN: {
    type: 'subdomain',
    // no oidcClient field
  },
};

beforeEach(() => {
  getTemplateVariablesMock.mockReset();
  fetchSpy.mockReset();
});

describe('authelia.handleInstalled', () => {
  it('no-ops when template has no oidcClient declaration', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_NO_OIDC);
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: VARS_PUBLIC,
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on a LAN-only install (no PUBLIC_DOMAIN)', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_WITH_OIDC);
    const lanVars: StackVariable[] = [
      { name: 'IMMICH_SUBDOMAIN', value: 'photos', meta: { type: 'subdomain' } as StackVariable['meta'] },
    ];
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: lanVars,
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the OIDC clients endpoint when the template has oidc + public domain', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_WITH_OIDC);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ added: ['immich'], skipped: [] }), { status: 200 }));

    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: VARS_PUBLIC,
    });

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/system/authelia/oidc-clients');
    const body = JSON.parse(String(init!.body));
    expect(body.templates).toEqual([{ name: 'immich' }]);
    expect(body.variables.PUBLIC_DOMAIN).toBe('dopp.cloud');
  });

  it('treats 404 (Authelia not deployed) as a soft skip', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_WITH_OIDC);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: VARS_PUBLIC,
    });
    expect(r.ok).toBe(true);
  });

  it('surfaces 5xx as retryable failure', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_WITH_OIDC);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authelia config corrupted' }), { status: 500 }));
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: VARS_PUBLIC,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/authelia config corrupted/);
  });

  it('surfaces fetch network errors as retryable failure', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_WITH_OIDC);
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: VARS_PUBLIC,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/ECONNREFUSED/);
  });
});

describe('authelia.handleUninstalled', () => {
  it('no-ops when template has no oidcClient declaration', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce(META_NO_OIDC);
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('issues a DELETE per declared client_id', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce({
      A_SUB: { type: 'subdomain', oidcClient: { client_id: 'a' } },
      B_SUB: { type: 'subdomain', oidcClient: { client_id: 'b' } },
    });
    fetchSpy.mockResolvedValue(new Response('{"removed":true}', { status: 200 }));
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'foo', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.endsWith('/api/system/authelia/oidc-clients/a'))).toBe(true);
    expect(urls.some(u => u.endsWith('/api/system/authelia/oidc-clients/b'))).toBe(true);
    for (const call of fetchSpy.mock.calls) expect(call[1]?.method).toBe('DELETE');
  });

  it('treats 404 (already gone) as success — idempotent uninstall', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce({
      IMMICH_SUB: { type: 'subdomain', oidcClient: { client_id: 'immich' } },
    });
    fetchSpy.mockResolvedValueOnce(new Response('{"removed":false}', { status: 404 }));
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [],
    });
    expect(r.ok).toBe(true);
  });

  it('aggregates failures across clients and surfaces them all', async () => {
    getTemplateVariablesMock.mockResolvedValueOnce({
      A_SUB: { type: 'subdomain', oidcClient: { client_id: 'a' } },
      B_SUB: { type: 'subdomain', oidcClient: { client_id: 'b' } },
    });
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'config locked' }), { status: 500 }))
      .mockResolvedValueOnce(new Response('{"removed":true}', { status: 200 }));
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'foo', lastKnownVariables: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/a: config locked/);
    expect(r.message).not.toMatch(/^b:/m); // B succeeded
  });
});
