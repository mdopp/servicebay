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

describe('buildServiceBundlesForNode — hand-rolled Quadlet units are unmanaged (#2395)', () => {
  const handRolled = () =>
    makeService({
      name: 'beets.service',
      isManaged: true, // agent flags ANY .kube/.container unit, template or not
      path: '/var/home/core/.config/containers/systemd/beets.kube',
      fragmentPath: '/var/home/core/.config/containers/systemd/beets.kube',
      associatedContainerIds: ['c-beets'],
    });
  const handRolledContainer = () =>
    makeContainer({ id: 'c-beets', names: ['beets'], image: 'lscr.io/linuxserver/beets:latest' });

  const findBeets = (installedTemplates?: Set<string>) =>
    buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [handRolled()],
      containers: [handRolledContainer()],
      files: {},
      installedTemplates,
    }).find(b => b.services?.some(s => s.serviceName === 'beets.service'));

  it('surfaces a Quadlet-backed unit that matches no installed template', () => {
    // The whole point of #2395: `isManaged: true` only means ".kube/.container
    // on disk", so a unit ServiceBay never installed must still be scanned.
    expect(findBeets(new Set(['media', 'nginx']))).toBeDefined();
  });

  it('still hides the unit once it IS an installed template', () => {
    expect(findBeets(new Set(['media', 'beets']))).toBeUndefined();
  });

  it('does not reclassify a `<template>-<suffix>` sidecar Quadlet as unmanaged', () => {
    // solaris-whisper.container et al. are written by the solaris template's
    // post-deploy and never get their own installedTemplates entry — they must
    // stay managed.
    const bundles = buildServiceBundlesForNode({
      nodeName: 'Local',
      services: [
        makeService({
          name: 'solaris-whisper.service',
          isManaged: true,
          path: '/var/home/core/.config/containers/systemd/solaris-whisper.container',
          fragmentPath: '/var/home/core/.config/containers/systemd/solaris-whisper.container',
          associatedContainerIds: ['c-whisper'],
        }),
      ],
      containers: [makeContainer({ id: 'c-whisper', names: ['solaris-whisper'] })],
      files: {},
      installedTemplates: new Set(['solaris']),
    });
    expect(bundles.find(b => b.services?.some(s => s.serviceName === 'solaris-whisper.service'))).toBeUndefined();
  });

  it('keeps trusting the Quadlet flag when installedTemplates is unknown', () => {
    // No install record (twin not seeded / pre-#353 box) -> must NOT declare
    // every Quadlet-backed service on the box unmanaged.
    expect(findBeets(undefined)).toBeUndefined();
    expect(findBeets(new Set())).toBeUndefined();
  });
});
