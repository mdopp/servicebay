/**
 * NPM (nginx) capability handler tests (#630).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));

import { handleInstalled, handleUninstalled } from './nginx';
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const MANIFEST: TemplateManifest = {
  label: 'Test', tier: 'feature', schemaVersion: 1, dependencies: [],
};

/** Subdomain variable belonging to `template`. The `service` field in
 *  the built host is derived from `templateName` if set, else from the
 *  variable name. Our handler filters hosts by `service === template`,
 *  so the `templateName` declaration here is what binds the host to
 *  this template's events. */
function subdomainVar(template: string, varName: string, sub: string): StackVariable {
  return {
    name: varName,
    value: sub,
    meta: {
      type: 'subdomain',
      templateName: template,
      proxyPort: '2283',
      exposure: 'public',
    } as StackVariable['meta'],
  };
}

const PUB_DOMAIN: StackVariable = { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' };

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('nginx.handleInstalled', () => {
  it('no-ops when template has no subdomain variables', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'foo', manifest: MANIFEST, variables: [PUB_DOMAIN],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on pure LAN install (no PUBLIC_DOMAIN)', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos')],
    });
    // buildProxyHosts returns no `domain` without PUBLIC_DOMAIN
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs proxy-hosts for this template only (ignores other templates\' subdomain vars)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ created: ['photos.dopp.cloud'] }), { status: 200 }));
    const vars: StackVariable[] = [
      PUB_DOMAIN,
      subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos'),
      // A second subdomain var owned by a different template — must NOT
      // be included in the POST that immich's install event triggers.
      subdomainVar('vaultwarden', 'VAULTWARDEN_SUBDOMAIN', 'vault'),
    ];

    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST, variables: vars,
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]!.body));
    expect(body.publicDomain).toBe('dopp.cloud');
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0].domain).toBe('photos.dopp.cloud');
    expect(body.hosts[0].service).toBe('immich');
  });

  it('surfaces 401 (NPM not bootstrapped) as retryable so diagnose can prompt', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'NPM unauth', needsCredentials: true }), { status: 401 }));
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [PUB_DOMAIN, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos')],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/NPM unauth/);
  });

  it('surfaces fetch errors as retryable failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [PUB_DOMAIN, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos')],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/ECONNREFUSED/);
  });
});

describe('nginx.handleUninstalled', () => {
  it('no-ops when the template owned no proxy hosts', async () => {
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [PUB_DOMAIN],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs by domain for each host the template owned, using lastKnownVariables', async () => {
    fetchSpy.mockResolvedValue(new Response('{"removed":true}', { status: 200 }));
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich',
      lastKnownVariables: [
        PUB_DOMAIN,
        subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos'),
      ],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/system\/nginx\/proxy-hosts\?domain=photos\.dopp\.cloud/);
    expect(init?.method).toBe('DELETE');
  });

  it('treats 404 (already gone) as idempotent success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"removed":false}', { status: 404 }));
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich',
      lastKnownVariables: [
        PUB_DOMAIN,
        subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos'),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('aggregates failures across hosts', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'auth_failed' }), { status: 401 }))
      .mockResolvedValueOnce(new Response('{"removed":true}', { status: 200 }));
    // Two subdomain vars for the same template — both should be attempted.
    const vars: StackVariable[] = [
      PUB_DOMAIN,
      subdomainVar('media', 'JELLYFIN_SUBDOMAIN', 'jellyfin'),
      subdomainVar('media', 'AUDIOBOOKSHELF_SUBDOMAIN', 'books'),
    ];
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'media', lastKnownVariables: vars,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/auth_failed/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
