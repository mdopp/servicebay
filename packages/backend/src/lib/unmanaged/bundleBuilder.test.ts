import { describe, it, expect } from 'vitest';
import { buildServiceBundlesForNode } from './bundleBuilder';
import type { ServiceUnit, EnrichedContainer } from '@/lib/agent/types';

function makeService(overrides: Partial<ServiceUnit> = {}): ServiceUnit {
  return {
    name: 'ollama.service',
    active: true,
    activeState: 'active',
    subState: 'running',
    loadState: 'loaded',
    description: '',
    path: '/var/home/core/.config/containers/systemd/ollama.container',
    fragmentPath: '/var/home/core/.config/containers/systemd/ollama.container',
    isManaged: false,
    associatedContainerIds: ['c-ollama'],
    ports: [],
    ...overrides,
  };
}

function makeContainer(overrides: Partial<EnrichedContainer> = {}): EnrichedContainer {
  return {
    id: 'c-ollama',
    names: ['ollama'],
    image: 'docker.io/ollama/ollama:latest',
    state: 'running',
    status: 'Up',
    ports: [],
    labels: { PODMAN_SYSTEMD_UNIT: 'ollama.service' },
    ...overrides,
  } as unknown as EnrichedContainer;
}

describe('buildServiceBundlesForNode — installedTemplates managed detection (#1733)', () => {
  it('does NOT bundle a single-container .container Quadlet whose base name is in installedTemplates', () => {
    const bundles = buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [makeService()],
      containers: [makeContainer()],
      files: {},
      installedTemplates: new Set(['ollama']),
    });
    // installedTemplates says ollama is a managed service -> it must not show up
    // in the Standalone/unmanaged bundle list.
    const ollamaBundle = bundles.find(b => b.services?.some(s => s.serviceName === 'ollama.service'));
    expect(ollamaBundle).toBeUndefined();
  });

  it('DOES bundle the same unit when its base name is NOT in installedTemplates', () => {
    const bundles = buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [makeService()],
      containers: [makeContainer()],
      files: {},
      installedTemplates: new Set(['something-else']),
    });
    const ollamaBundle = bundles.find(b => b.services?.some(s => s.serviceName === 'ollama.service'));
    expect(ollamaBundle).toBeDefined();
  });

  it('still bundles an unmanaged unit when no installedTemplates set is supplied', () => {
    const bundles = buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [makeService()],
      containers: [makeContainer()],
      files: {},
    });
    const ollamaBundle = bundles.find(b => b.services?.some(s => s.serviceName === 'ollama.service'));
    expect(ollamaBundle).toBeDefined();
  });

  it('respects the agent isManaged flag regardless of installedTemplates', () => {
    const bundles = buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [makeService({ isManaged: true })],
      containers: [makeContainer()],
      files: {},
      installedTemplates: new Set(),
    });
    const ollamaBundle = bundles.find(b => b.services?.some(s => s.serviceName === 'ollama.service'));
    expect(ollamaBundle).toBeUndefined();
  });
});
