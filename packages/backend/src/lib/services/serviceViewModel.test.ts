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

describe('buildServiceViewModel — managed detection for .container Quadlets (#1733)', () => {
  // A single-container .container Quadlet (the ollama GPU fixup, #1026) has no
  // .kube/pod, so the agent may not flag it managed. When its base name is in
  // installedTemplates it must still resolve as a managed service, not fall
  // through to null (which would group it under Standalone Containers).
  function makeContainerUnit(overrides: Partial<ServiceUnit> = {}): ServiceUnit {
    return makeUnit({
      name: 'ollama.service',
      path: '/var/home/core/.config/containers/systemd/ollama.container',
      isManaged: false,
      ...overrides,
    });
  }

  it('resolves managed when base name is in installedTemplates even with isManaged=false and no .kube', () => {
    const vm = buildServiceViewModel({
      unit: makeContainerUnit(),
      nodeName: 'Local',
      nodeState: makeTwin(),
      installedTemplates: ['ollama'],
    });
    expect(vm).not.toBeNull();
    expect(vm?.isManaged).toBe(true);
    expect(vm?.type).toBe('kube');
    expect(vm?.displayName).toBe('ollama');
  });

  it('still returns null for an unflagged .container unit NOT in installedTemplates', () => {
    const vm = buildServiceViewModel({
      unit: makeContainerUnit({ name: 'stray.service' }),
      nodeName: 'Local',
      nodeState: makeTwin(),
      installedTemplates: ['ollama'],
    });
    expect(vm).toBeNull();
  });

  it('still resolves managed via the agent isManaged flag with no installedTemplates passed', () => {
    const vm = buildServiceViewModel({
      unit: makeContainerUnit({ isManaged: true }),
      nodeName: 'Local',
      nodeState: makeTwin(),
    });
    expect(vm).not.toBeNull();
    expect(vm?.isManaged).toBe(true);
  });

  it('is generic — any installedTemplates base name resolves, not just ollama', () => {
    const vm = buildServiceViewModel({
      unit: makeContainerUnit({ name: 'whisper.service', path: '/x/whisper.container' }),
      nodeName: 'Local',
      nodeState: makeTwin(),
      installedTemplates: ['whisper'],
    });
    expect(vm).not.toBeNull();
    expect(vm?.isManaged).toBe(true);
  });
});
