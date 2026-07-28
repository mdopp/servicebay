/**
 * Health-check → service attribution (#2394), the second half of #2080.
 *
 * These pin the *structural* resolution the backend stamps onto each row:
 * a `domain:` check resolves through the twin's verified proxy domains (or
 * the route's upstream port), and a diagnose row resolves through its own
 * per-item container / unit / service names — but only when every item
 * agrees, so a genuinely node-wide probe keeps its box-wide home.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichedContainer, ServiceUnit } from '@/lib/agent/types';

const twin: { services: ServiceUnit[]; containers: EnrichedContainer[] } = {
  services: [],
  containers: [],
};

vi.mock('@/lib/store/repository', () => ({
  getServices: () => twin.services,
  getContainers: () => twin.containers,
}));

import {
  baseServiceName,
  buildServiceAttributionIndex,
  emptyAttributionIndex,
  normalizeDomain,
  resolveDiagnoseProbeService,
  resolveDomainCheckService,
  resolveProbeItemService,
} from './checkAttribution';

const service = (over: Partial<ServiceUnit> & { name: string }): ServiceUnit => ({
  activeState: 'active',
  subState: 'running',
  loadState: 'loaded',
  description: '',
  path: '',
  ...over,
} as ServiceUnit);

const container = (over: Partial<EnrichedContainer> & { names: string[] }): EnrichedContainer => ({
  id: over.names[0],
  image: 'img',
  state: 'running',
  status: 'Up 2 hours',
  created: 0,
  ports: [],
  mounts: [],
  labels: {},
  networks: [],
  ...over,
} as EnrichedContainer);

beforeEach(() => {
  twin.services = [];
  twin.containers = [];
});

describe('normalizeDomain / baseServiceName', () => {
  it('reduces a verified-domain entry to its bare lower-cased host', () => {
    expect(normalizeDomain('media.dopp.cloud')).toBe('media.dopp.cloud');
    // the twin records some routes as full URLs
    expect(normalizeDomain('https://Media.dopp.cloud/')).toBe('media.dopp.cloud');
    expect(normalizeDomain('http://paperless.home.arpa:8080')).toBe('paperless.home.arpa');
  });

  it('strips systemd unit suffixes so media.service === media', () => {
    expect(baseServiceName('media.service')).toBe('media');
    expect(baseServiceName('immich.socket')).toBe('immich');
    expect(baseServiceName('media')).toBe('media');
  });
});

describe('buildServiceAttributionIndex', () => {
  it('indexes service domains, host ports and <service>-<app> container names', () => {
    twin.services = [
      service({ name: 'media.service', verifiedDomains: ['media.dopp.cloud'], ports: [{ hostPort: 8096, protocol: 'tcp' }] }),
      service({ name: 'paperless.service', verifiedDomains: ['https://paperless.dopp.cloud'] }),
    ];
    twin.containers = [
      container({ names: ['media-jellyfin'], labels: { PODMAN_SYSTEMD_UNIT: 'media.service' } }),
      // no unit label — the pod name is the documented fallback
      container({ names: ['paperless-web'], podName: 'paperless' }),
    ];
    const index = buildServiceAttributionIndex('Local');
    expect(index.services).toEqual(new Set(['media', 'paperless']));
    expect(index.domains.get('media.dopp.cloud')).toBe('media');
    expect(index.domains.get('paperless.dopp.cloud')).toBe('paperless');
    expect(index.hostPorts.get(8096)).toBe('media');
    expect(index.containers.get('media-jellyfin')).toBe('media');
    expect(index.containers.get('paperless-web')).toBe('paperless');
  });

  it('folds a container-level verified domain onto its owning service', () => {
    // Multi-app stacks: the twin's reverse lookup matches the CONTAINER's
    // published port, so the domain lands on `media-jellyfin`, not `media`.
    twin.services = [service({ name: 'media.service' })];
    twin.containers = [
      container({
        names: ['media-jellyfin'],
        labels: { PODMAN_SYSTEMD_UNIT: 'media.service' },
        verifiedDomains: ['media.dopp.cloud'],
        ports: [{ hostPort: 8096, protocol: 'tcp' }],
      }),
    ];
    const index = buildServiceAttributionIndex('Local');
    expect(index.domains.get('media.dopp.cloud')).toBe('media');
    expect(index.hostPorts.get(8096)).toBe('media');
  });
});

describe('resolveDomainCheckService (#2394 criterion 1)', () => {
  it('attributes a service own verified domain to that service', () => {
    twin.services = [service({ name: 'media.service', verifiedDomains: ['media.dopp.cloud'] })];
    const index = buildServiceAttributionIndex('Local');
    expect(resolveDomainCheckService('media.dopp.cloud', undefined, index)).toBe('media');
  });

  it('falls back to the route upstream port when the domain is not in the twin yet', () => {
    twin.services = [service({ name: 'paperless.service', ports: [{ hostPort: 8000, protocol: 'tcp' }] })];
    const index = buildServiceAttributionIndex('Local');
    expect(resolveDomainCheckService('paperless.dopp.cloud', 8000, index)).toBe('paperless');
  });

  it('leaves an orphan domain unattributed so it stays box-wide, not hidden', () => {
    twin.services = [service({ name: 'media.service', verifiedDomains: ['media.dopp.cloud'] })];
    const index = buildServiceAttributionIndex('Local');
    expect(resolveDomainCheckService('stale.dopp.cloud', 9999, index)).toBeNull();
    expect(resolveDomainCheckService(undefined, undefined, index)).toBeNull();
  });
});

describe('resolveProbeItemService', () => {
  beforeEach(() => {
    twin.services = [service({ name: 'media.service' }), service({ name: 'paperless.service' })];
    twin.containers = [container({ names: ['media-jellyfin'], labels: { PODMAN_SYSTEMD_UNIT: 'media.service' } })];
  });

  it('maps a container name back to its owning service', () => {
    const index = buildServiceAttributionIndex('Local');
    expect(resolveProbeItemService('media-jellyfin', 'container', index)).toBe('media');
    // convention fallback for a container the twin has not inventoried yet
    expect(resolveProbeItemService('media-audiobookshelf', 'container', index)).toBe('media');
    expect(resolveProbeItemService('unknown-thing', 'container', index)).toBeNull();
  });

  it('maps a failed unit name and a bare service name', () => {
    const index = buildServiceAttributionIndex('Local');
    expect(resolveProbeItemService('paperless.service', 'unit', index)).toBe('paperless');
    expect(resolveProbeItemService('paperless', 'service', index)).toBe('paperless');
    expect(resolveProbeItemService('nope.service', 'unit', index)).toBeNull();
    expect(resolveProbeItemService('', 'service', index)).toBeNull();
  });
});

describe('resolveDiagnoseProbeService (#2394 criterion 2)', () => {
  beforeEach(() => {
    twin.services = [service({ name: 'media.service' }), service({ name: 'paperless.service' })];
    twin.containers = [
      container({ names: ['media-jellyfin'], labels: { PODMAN_SYSTEMD_UNIT: 'media.service' } }),
      container({ names: ['paperless-web'], labels: { PODMAN_SYSTEMD_UNIT: 'paperless.service' } }),
    ];
  });

  it('attributes crash_loop / failed_units / post_deploy_failed to the owning stack', () => {
    const index = buildServiceAttributionIndex('Local');
    expect(resolveDiagnoseProbeService('crash_loop', [{ id: 'media-jellyfin' }], index)).toBe('media');
    expect(resolveDiagnoseProbeService('failed_units', [{ id: 'paperless.service' }], index)).toBe('paperless');
    expect(resolveDiagnoseProbeService('post_deploy_failed', [{ id: 'media' }], index)).toBe('media');
  });

  it('stays box-wide when the row spans two stacks, has no items, or is unresolvable', () => {
    const index = buildServiceAttributionIndex('Local');
    // two stacks crash-looping is a box-level story, not one service's
    expect(resolveDiagnoseProbeService('crash_loop', [{ id: 'media-jellyfin' }, { id: 'paperless-web' }], index)).toBeNull();
    // "all containers stable" is a statement about the node
    expect(resolveDiagnoseProbeService('crash_loop', [], index)).toBeNull();
    expect(resolveDiagnoseProbeService('crash_loop', undefined, index)).toBeNull();
    expect(resolveDiagnoseProbeService('crash_loop', [{ id: 'strange-thing' }], index)).toBeNull();
  });

  it('never attributes a genuinely platform-level probe (#2394 criterion 3)', () => {
    const index = buildServiceAttributionIndex('Local');
    // DNS / TLS infra, storage and USB stay box-wide even though their items
    // name a domain that DOES belong to a service.
    twin.services.push(service({ name: 'media.service', verifiedDomains: ['media.dopp.cloud'] }));
    for (const probeId of ['domain_resolves_to_box', 'dns_routing', 'cert_expiry', 'disk', 'serial', 'domain_unreachable']) {
      expect(resolveDiagnoseProbeService(probeId, [{ id: 'media.dopp.cloud' }], index)).toBeNull();
    }
  });

  it('resolves nothing against an empty index (twin still syncing)', () => {
    expect(resolveDiagnoseProbeService('crash_loop', [{ id: 'media-jellyfin' }], emptyAttributionIndex())).toBeNull();
    expect(resolveDomainCheckService('media.dopp.cloud', 8096, emptyAttributionIndex())).toBeNull();
  });
});
