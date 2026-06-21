/**
 * IA slice 1 (#2029) — the shared per-service detail relies on these pure
 * helpers to stay in sync between the Operate page header and the Network-map
 * node sidebar. They are the single source of truth for "does this check belong
 * to this service", "what's the rolled-up health dot", and "what URL do we
 * open" — so pin them here.
 */
import { describe, it, expect } from 'vitest';
import type { Check, ServiceViewModel } from '@servicebay/api-client';
import {
  checkBelongsToService,
  overallHealth,
  serviceBaseName,
} from './serviceHealth';
import { primaryServiceUrl } from './ServiceDetailSummary';

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'jellyfin.service',
    displayName: 'Jellyfin',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    ...over,
  };
}

function check(over: Partial<Check>): Check {
  return { id: 'c', name: 'x', type: 'http', status: 'ok', ...over } as Check;
}

describe('serviceBaseName', () => {
  it('strips the systemd unit suffix and prefers id', () => {
    expect(serviceBaseName({ id: 'media.service', name: 'x' })).toBe('media');
    expect(serviceBaseName({ name: 'immich.socket' })).toBe('immich');
  });
});

describe('checkBelongsToService', () => {
  it('matches on target equality, substring and name', () => {
    expect(checkBelongsToService(check({ target: 'jellyfin' }), 'jellyfin')).toBe(true);
    expect(checkBelongsToService(check({ target: 'media-jellyfin' }), 'jellyfin')).toBe(true);
    expect(checkBelongsToService(check({ name: 'Jellyfin libraries indexed' }), 'jellyfin')).toBe(true);
    expect(checkBelongsToService(check({ target: 'immich', name: 'photos' }), 'jellyfin')).toBe(false);
  });
});

describe('overallHealth', () => {
  it('worst-status-wins, then ok, then unknown', () => {
    expect(overallHealth({ ok: 3, warn: 1, fail: 2, unknown: 0 })).toBe('fail');
    expect(overallHealth({ ok: 3, warn: 1, fail: 0, unknown: 0 })).toBe('warn');
    expect(overallHealth({ ok: 3, warn: 0, fail: 0, unknown: 5 })).toBe('ok');
    expect(overallHealth({ ok: 0, warn: 0, fail: 0, unknown: 0 })).toBe('unknown');
  });
});

describe('primaryServiceUrl', () => {
  it('prefers a verified domain (https), then url, then host port', () => {
    expect(primaryServiceUrl(svc({ verifiedDomains: ['media.dopp.cloud'] }))).toBe('https://media.dopp.cloud');
    expect(primaryServiceUrl(svc({ verifiedDomains: ['https://x.dopp.cloud'] }))).toBe('https://x.dopp.cloud');
    expect(primaryServiceUrl(svc({ url: 'http://example.com' }))).toBe('http://example.com');
    // internal markers without a dot are skipped as domains.
    expect(primaryServiceUrl(svc({ verifiedDomains: ['localhost-marker'] }))).toBeNull();
  });

  it('returns null when there is nothing to open', () => {
    expect(primaryServiceUrl(svc())).toBeNull();
  });
});
