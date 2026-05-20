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

import { findNpmAdminUrl } from './npmAdmin';

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
