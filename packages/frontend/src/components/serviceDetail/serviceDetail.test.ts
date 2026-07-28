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
  isBoxWideCheck,
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

describe('checkBelongsToService (#2080 structural attribution)', () => {
  it('matches the canonical per-service check shapes', () => {
    // init.ts creates `type:'service'` with target === serviceName …
    expect(checkBelongsToService(check({ type: 'service', target: 'jellyfin' }), 'jellyfin')).toBe(true);
    // … or the legacy `name === "Service: <name>"` row …
    expect(checkBelongsToService(check({ name: 'Service: jellyfin' }), 'jellyfin')).toBe(true);
    // … and a systemd-suffixed target still resolves to the bare name.
    expect(checkBelongsToService(check({ type: 'systemd', target: 'jellyfin.service' }), 'jellyfin')).toBe(true);
    // template/post-deploy probes carry id === <svc> or id.startsWith("<svc>-")
    expect(checkBelongsToService(check({ id: 'jellyfin-api', target: 'http://x' }), 'jellyfin')).toBe(true);
  });

  it('does NOT over-match on loose substrings (the old "1 ok" bug)', () => {
    // The old impl matched any check whose name/target CONTAINED the needle,
    // sweeping unrelated rows onto a service. A free-text name no longer counts.
    expect(checkBelongsToService(check({ name: 'Jellyfin libraries indexed' }), 'jellyfin')).toBe(false);
    expect(checkBelongsToService(check({ target: 'media-jellyfin' }), 'jellyfin')).toBe(false);
    expect(checkBelongsToService(check({ target: 'immich', name: 'photos' }), 'jellyfin')).toBe(false);
  });

  // #2394 — the backend now resolves a domain check / an item-bearing diagnose
  // row to its owning stack and stamps `serviceName`. That stamp is
  // authoritative in BOTH directions: the check belongs to that service, and
  // never falls through to the id/target heuristics for any other.
  it('honours the backend-stamped serviceName over every other shape', () => {
    const domainCheck = check({ id: 'domain:media.dopp.cloud', name: 'Domain — media.dopp.cloud', type: 'domain', target: 'media.dopp.cloud', serviceName: 'media' });
    expect(checkBelongsToService(domainCheck, 'media')).toBe(true);
    expect(checkBelongsToService(domainCheck, 'paperless')).toBe(false);
    // systemd-suffixed stamp still resolves to the bare base name
    expect(checkBelongsToService(check({ serviceName: 'media.service' }), 'media')).toBe(true);
    // an attributed diagnose row lands on its owning service, not box-wide
    const crashLoop = check({ id: 'diagnose:crash_loop', target: 'crash_loop', serviceName: 'media' });
    expect(checkBelongsToService(crashLoop, 'media')).toBe(true);
    expect(checkBelongsToService(crashLoop, 'jellyfin')).toBe(false);
    // a stamp for another service wins over an id-prefix coincidence
    expect(checkBelongsToService(check({ id: 'jellyfin-api', serviceName: 'media' }), 'jellyfin')).toBe(false);
  });

  it('never attributes a box-wide check to a service', () => {
    expect(checkBelongsToService(check({ id: 'diagnose:cert_expiry', target: 'cert_expiry', boxWide: true }), 'jellyfin')).toBe(false);
    expect(checkBelongsToService(check({ type: 'cert_expiry', target: 'Local' }), 'jellyfin')).toBe(false);
    expect(checkBelongsToService(check({ type: 'agent', target: 'Local' }), 'jellyfin')).toBe(false);
  });
});

describe('isBoxWideCheck (#2080)', () => {
  it('flags diagnose probes, node-singleton types and Local-targeted checks', () => {
    expect(isBoxWideCheck(check({ id: 'diagnose:cert_expiry', boxWide: true }))).toBe(true);
    // boxWide flag absent but the synthetic id prefix still classifies it.
    expect(isBoxWideCheck(check({ id: 'diagnose:dns_routing' }))).toBe(true);
    expect(isBoxWideCheck(check({ type: 'cert_expiry', target: 'Local' }))).toBe(true);
    expect(isBoxWideCheck(check({ type: 'agent', target: 'Local' }))).toBe(true);
    expect(isBoxWideCheck(check({ type: 'service', target: 'Local' }))).toBe(true);
  });

  it('does NOT flag a normal per-service check', () => {
    expect(isBoxWideCheck(check({ type: 'service', target: 'jellyfin' }))).toBe(false);
    expect(isBoxWideCheck(check({ type: 'http', target: 'jellyfin' }))).toBe(false);
  });

  // #2394 — `domain` was hard-coded box-wide, so every `domain:<host>` check
  // sat in the generic list even though the host maps 1:1 to a service.
  it('files an attributed check with its service, not the box-wide list', () => {
    expect(isBoxWideCheck(check({ id: 'domain:media.dopp.cloud', type: 'domain', target: 'media.dopp.cloud', serviceName: 'media' }))).toBe(false);
    expect(isBoxWideCheck(check({ id: 'diagnose:crash_loop', boxWide: false, serviceName: 'media' }))).toBe(false);
  });

  it('keeps an UNCLAIMED domain check box-wide rather than hiding it', () => {
    // Nothing on the box owns the route → an orphan domain IS a box-level
    // finding. It must stay visible somewhere, not vanish from every tab.
    expect(isBoxWideCheck(check({ id: 'domain:stale.dopp.cloud', type: 'domain', target: 'stale.dopp.cloud' }))).toBe(true);
    expect(isBoxWideCheck(check({ type: 'letsdebug', target: 'stale.dopp.cloud' }))).toBe(true);
    // …and DNS/TLS infra is never attributed in the first place.
    expect(isBoxWideCheck(check({ type: 'dns_routing', target: 'media.dopp.cloud' }))).toBe(true);
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
