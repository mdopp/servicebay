/**
 * AdGuard capability handler tests (#631).
 *
 * Mocks the AdGuard rewrites library + the portal-config helpers. The
 * handler is otherwise a pure dispatch over those primitives, so the
 * tests focus on the routing decisions (which subdomains get a rewrite,
 * which get skipped, what counts as success).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureMock = vi.fn();
const removeMock = vi.fn();
const findCredsMock = vi.fn();
const findLanIpMock = vi.fn();

vi.mock('@/lib/adguard/rewrites', () => ({
  ensureWildcardRewrite: (...a: unknown[]) => ensureMock(...a),
  removeWildcardRewrite: (...a: unknown[]) => removeMock(...a),
}));
vi.mock('@/lib/portal/provisioner', () => ({
  findAdguardCreds: () => findCredsMock(),
  findServiceBayLanIp: () => findLanIpMock(),
}));

import { handleInstalled, handleUninstalled } from './adguard';
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

const MANIFEST: TemplateManifest = {
  label: 'X', tier: 'feature', schemaVersion: 1, dependencies: [],
};

function subdomainVar(
  template: string,
  name: string,
  value: string,
  exposure: 'public' | 'lan' | 'internal',
): StackVariable {
  return {
    name,
    value,
    meta: {
      type: 'subdomain',
      templateName: template,
      exposure,
    } as StackVariable['meta'],
  };
}

const PUB: StackVariable = { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' };

beforeEach(() => {
  ensureMock.mockReset();
  removeMock.mockReset();
  findCredsMock.mockReset();
  findLanIpMock.mockReset();
});

describe('adguard.handleInstalled', () => {
  it('no-ops when template owns no lan/internal subdomain vars', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [PUB, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'public')],
    });
    expect(r.ok).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('no-ops on pure LAN install (no PUBLIC_DOMAIN — wildcard covers it)', async () => {
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'lan')],
    });
    expect(r.ok).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('skips with ok:true when AdGuard creds/LAN-IP aren\'t available yet', async () => {
    findCredsMock.mockResolvedValueOnce(null);
    findLanIpMock.mockResolvedValueOnce(null);
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [PUB, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'lan')],
    });
    expect(r.ok).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('adds rewrites for each owned lan/internal subdomain, ignores other templates', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    findLanIpMock.mockResolvedValue('192.168.1.10');
    ensureMock.mockResolvedValue('added');
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [
        PUB,
        subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'lan'),
        subdomainVar('immich', 'IMMICH_PUBLIC', 'public-photos', 'public'),  // skip — public
        subdomainVar('vaultwarden', 'VAULTWARDEN_SUBDOMAIN', 'vault', 'lan'), // skip — other template
      ],
    });
    expect(r.ok).toBe(true);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][1]).toBe('photos.dopp.cloud');
    expect(ensureMock.mock.calls[0][2]).toBe('192.168.1.10');
  });

  it('returns ok:true for unchanged/updated rewrites', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    findLanIpMock.mockResolvedValue('192.168.1.10');
    ensureMock.mockResolvedValueOnce('unchanged');
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'immich', manifest: MANIFEST,
      variables: [PUB, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'lan')],
    });
    expect(r.ok).toBe(true);
  });

  it('aggregates failures across names', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    findLanIpMock.mockResolvedValue('192.168.1.10');
    ensureMock
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('added');
    const r = await handleInstalled({
      kind: 'feature.installed', template: 'media', manifest: MANIFEST,
      variables: [
        PUB,
        subdomainVar('media', 'JELLYFIN_SUBDOMAIN', 'jellyfin', 'lan'),
        subdomainVar('media', 'AUDIOBOOKSHELF_SUBDOMAIN', 'books', 'lan'),
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/jellyfin\.dopp\.cloud/);
  });
});

describe('adguard.handleUninstalled', () => {
  it('no-ops when template owned no rewrites', async () => {
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich', lastKnownVariables: [PUB],
    });
    expect(r.ok).toBe(true);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('removes per-subdomain rewrites the template owned', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    removeMock.mockResolvedValue('removed');
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'media',
      lastKnownVariables: [
        PUB,
        subdomainVar('media', 'JELLYFIN_SUBDOMAIN', 'jellyfin', 'lan'),
        subdomainVar('media', 'AUDIOBOOKSHELF_SUBDOMAIN', 'books', 'internal'),
      ],
    });
    expect(r.ok).toBe(true);
    expect(removeMock).toHaveBeenCalledTimes(2);
  });

  it('treats absent rewrites as idempotent success', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    removeMock.mockResolvedValue('absent');
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'immich',
      lastKnownVariables: [PUB, subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos', 'lan')],
    });
    expect(r.ok).toBe(true);
  });

  it('aggregates failures', async () => {
    findCredsMock.mockResolvedValue({ adminUrl: 'http://x', username: 'a', password: 'p' });
    removeMock.mockResolvedValueOnce('failed').mockResolvedValueOnce('removed');
    const r = await handleUninstalled({
      kind: 'feature.uninstalled', template: 'media',
      lastKnownVariables: [
        PUB,
        subdomainVar('media', 'A_SUB', 'a', 'lan'),
        subdomainVar('media', 'B_SUB', 'b', 'lan'),
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
  });
});
