import { describe, it, expect } from 'vitest';
import { buildServiceViewModel } from './serviceViewModel';
import type { ServiceUnit } from '@/lib/agent/types';
import type { NodeTwin } from '@/lib/store/twin';

function makeUnit(overrides: Partial<ServiceUnit> = {}): ServiceUnit {
  return {
    name: 'vaultwarden.service',
    active: true,
    activeState: 'active',
    subState: 'running',
    loadState: 'loaded',
    description: '',
    path: '/var/home/core/.config/containers/systemd/vaultwarden.kube',
    isManaged: true,
    associatedContainerIds: [],
    ports: [],
    verifiedDomains: [],
    ...overrides,
  };
}

function makeTwin(files: Record<string, { content: string }> = {}): NodeTwin {
  return {
    connected: true,
    initialSyncComplete: true,
    containers: [],
    services: [],
    files,
    resources: undefined,
  } as unknown as NodeTwin;
}

describe('buildServiceViewModel — display fields (#844)', () => {
  it('strips `.service` from the unit name into displayName for normal services', () => {
    const vm = buildServiceViewModel({
      unit: makeUnit({ name: 'vaultwarden.service' }),
      nodeName: 'Local',
      nodeState: makeTwin(),
    });
    expect(vm).not.toBeNull();
    expect(vm?.displayName).toBe('vaultwarden');
    // id stays the unit identifier for matching/lookups
    expect(vm?.id).toBe('vaultwarden.service');
  });

  it('overrides displayName to "Reverse Proxy (Nginx)" for nginx', () => {
    const vm = buildServiceViewModel({
      unit: makeUnit({ name: 'nginx.service', isReverseProxy: true }),
      nodeName: 'Local',
      nodeState: makeTwin(),
    });
    expect(vm?.displayName).toBe('Reverse Proxy (Nginx)');
  });

  it('overrides displayName to "ServiceBay System" for the servicebay unit', () => {
    const vm = buildServiceViewModel({
      unit: makeUnit({ name: 'servicebay.service', isServiceBay: true, isManaged: false }),
      nodeName: 'Local',
      nodeState: makeTwin(),
    });
    expect(vm?.displayName).toBe('ServiceBay System');
  });

  it('extracts yamlBasename and kubeBasename from full paths', () => {
    const kubePath = '/var/home/core/.config/containers/systemd/vaultwarden.kube';
    const yamlPath = '/var/home/core/.config/containers/systemd/vaultwarden.yml';
    const vm = buildServiceViewModel({
      unit: makeUnit({ path: kubePath }),
      nodeName: 'Local',
      nodeState: makeTwin({
        [kubePath]: { content: `Yaml=vaultwarden.yml\n` },
        [yamlPath]: { content: 'apiVersion: v1\nkind: Pod\n' },
      }),
    });
    expect(vm?.kubeBasename).toBe('vaultwarden.kube');
    expect(vm?.yamlBasename).toBe('vaultwarden.yml');
  });

  it('returns null kubeBasename/yamlBasename when files are absent', () => {
    const vm = buildServiceViewModel({
      unit: makeUnit({ path: '' }),
      nodeName: 'Local',
      nodeState: makeTwin(),
    });
    expect(vm?.kubeBasename).toBeNull();
    expect(vm?.yamlBasename).toBeNull();
  });
});
