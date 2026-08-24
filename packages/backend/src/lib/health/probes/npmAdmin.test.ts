import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinNodes: Record<string, { services: unknown[]; containers: unknown[]; files: Record<string, unknown> }> = {};
const serviceList: unknown[] = [];

vi.mock('../../store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({ nodes: twinNodes }),
  },
}));

vi.mock('../../services/ServiceManager', () => ({
  ServiceManager: {
    listServices: vi.fn(async () => serviceList),
  },
}));

import { findNpmAdminUrl, indexProxyHostBindings, isCertOrphaned } from './npmAdmin';

beforeEach(() => {
  for (const k of Object.keys(twinNodes)) delete twinNodes[k];
  serviceList.length = 0;
});

describe('findNpmAdminUrl', () => {
  it('returns twin-not-ready when the twin has no entry for the node', async () => {
    const r = await findNpmAdminUrl('Local');
    expect(r.kind).toBe('twin-not-ready');
  });

  it('returns twin-not-ready when the twin entry has empty services and containers', async () => {
    twinNodes['Local'] = { services: [], containers: [], files: {} };
    const r = await findNpmAdminUrl('Local');
    expect(r.kind).toBe('twin-not-ready');
  });

  it('returns nginx-not-found when twin has data but no nginx service', async () => {
    twinNodes['Local'] = {
      services: [{ name: 'unrelated.service' }],
      containers: [{ id: 'abc' }],
      files: {},
    };
    serviceList.push({ name: 'adguard', ports: [] });
    const r = await findNpmAdminUrl('Local');
    expect(r.kind).toBe('nginx-not-found');
  });

  it('returns the admin URL even when nginx.active is false (kube unit-name mismatch)', async () => {
    // The bug we're fixing: kube-deployed nginx-pod's unit name doesn't
    // match the template `nginx` service name, so `active` reads false
    // even though every container in the pod is running. We trust the
    // twin entry's presence + port mapping and let the actual fetch
    // be the source of truth.
    twinNodes['Local'] = {
      services: [{ name: 'nginx-pod.service' }],
      containers: [{ id: 'abc' }],
      files: {},
    };
    serviceList.push({
      name: 'nginx-web',
      active: false,
      ports: [{ host: '80' }, { host: '443' }, { host: '8181' }],
    });
    const r = await findNpmAdminUrl('Local');
    expect(r).toEqual({ kind: 'url', url: 'http://localhost:8181' });
  });

  it('falls back to port 81 when the manifest exposes only 80/443', async () => {
    twinNodes['Local'] = {
      services: [{ name: 'nginx.service' }],
      containers: [],
      files: {},
    };
    serviceList.push({
      name: 'nginx',
      active: true,
      ports: [{ host: '80' }, { host: '443' }],
    });
    const r = await findNpmAdminUrl('Local');
    expect(r).toEqual({ kind: 'url', url: 'http://localhost:81' });
  });

  it('ignores `install-*` helper services and matches the real nginx', async () => {
    twinNodes['Local'] = {
      services: [{ name: 'nginx.service' }],
      containers: [],
      files: {},
    };
    serviceList.push(
      { name: 'install-nginx', active: true, ports: [] },
      { name: 'nginx-web', active: true, ports: [{ host: '8181' }] },
    );
    const r = await findNpmAdminUrl('Local');
    expect(r).toEqual({ kind: 'url', url: 'http://localhost:8181' });
  });
});

describe('cert → proxy-host binding (#2594)', () => {
  const hosts = [
    { id: 1, certificate_id: 7, domain_names: ['vault.example.com'] },
    { id: 2, certificate_id: 0, domain_names: ['plain.example.com'] },
  ];
  const bindings = indexProxyHostBindings(hosts);

  it('indexes both the selected cert ids and the served domains', () => {
    expect([...bindings.certIds]).toEqual([7]); // certificate_id 0 = "no cert"
    expect([...bindings.domains].sort()).toEqual(['plain.example.com', 'vault.example.com']);
  });

  it('survives a non-array / malformed body without throwing', () => {
    expect(indexProxyHostBindings(undefined).certIds.size).toBe(0);
    expect(indexProxyHostBindings([{ domain_names: 'nope' }]).domains.size).toBe(0);
  });

  it('is orphaned only when neither the id nor any domain is referenced', () => {
    expect(isCertOrphaned({ id: 7, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 7, domain_names: ['gone.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, bindings)).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['  VAULT.example.com '] }, bindings)).toBe(false);
  });

  it('treats a wildcard cert as in use while any host under it is served', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['*.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['*.other.com'] }, bindings)).toBe(true);
  });

  it('never reports orphaned when the host table is unknown, or the cert has no domains', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, null)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: [] }, bindings)).toBe(false);
  });
});
