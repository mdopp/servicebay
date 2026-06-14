import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DigitalTwinStore } from '@/lib/store/twin';

// #1733: installedTemplates feeds the bundle builder so a single-container
// .container Quadlet whose base name is an installed template is treated as a
// managed service instead of a Standalone container. These tests cover the
// thin setInstalledTemplates wrapper (set + change-detection + rebuild).
describe('DigitalTwinStore.setInstalledTemplates (#1733)', () => {
  let store: DigitalTwinStore;

  beforeEach(() => {
    store = DigitalTwinStore.getInstance();
    store.nodes = {};
    store.installedTemplates = new Set();
  });

  afterEach(() => {
    // Singleton store: restore spies so call records don't bleed across tests.
    vi.restoreAllMocks();
  });

  it('defaults to an empty set and exposes it on the snapshot', () => {
    expect([...store.installedTemplates]).toEqual([]);
    expect(store.getSnapshot().installedTemplates).toEqual([]);
  });

  it('stores the names and surfaces them on the snapshot', () => {
    store.setInstalledTemplates(['ollama', 'immich']);
    expect([...store.installedTemplates].sort()).toEqual(['immich', 'ollama']);
    expect(store.getSnapshot().installedTemplates.sort()).toEqual(['immich', 'ollama']);
  });

  it('rebuilds bundles for every node when the set changes', () => {
    store.registerNode('node-a');
    store.registerNode('node-b');
    const spy = vi.spyOn(store, 'rebuildBundlesNow');

    store.setInstalledTemplates(['ollama']);

    expect(spy).toHaveBeenCalledWith('node-a');
    expect(spy).toHaveBeenCalledWith('node-b');
  });

  it('does NOT rebuild when the set is unchanged (no churn on every config read)', () => {
    store.registerNode('node-a');
    store.setInstalledTemplates(['ollama', 'immich']);

    const spy = vi.spyOn(store, 'rebuildBundlesNow');
    // Same members, different iteration order — must be treated as unchanged.
    store.setInstalledTemplates(['immich', 'ollama']);

    expect(spy).not.toHaveBeenCalled();
  });

  it('rebuilds when a name is added or removed', () => {
    store.registerNode('node-a');
    store.setInstalledTemplates(['ollama']);

    const spy = vi.spyOn(store, 'rebuildBundlesNow');
    store.setInstalledTemplates(['ollama', 'immich']); // added
    expect(spy).toHaveBeenCalledTimes(1);

    store.setInstalledTemplates(['immich']); // removed ollama
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// The `isServiceBay` flag overrides a service's dashboard label to
// "ServiceBay System" / category "System". The detector must not confuse the
// dockerised Claude Code dev box (image `ghcr.io/mdopp/servicebay-claude-dev`)
// with the management system (image `ghcr.io/mdopp/servicebay`) just because
// the image names share the `servicebay` prefix.
describe('DigitalTwinStore.isServiceBay detection — servicebay-claude-dev must not be mis-flagged', () => {
  let store: DigitalTwinStore;

  beforeEach(() => {
    store = DigitalTwinStore.getInstance();
    store.nodes = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = (over: Record<string, any>): any => ({
    name: 'svc.service',
    activeState: 'active',
    subState: 'running',
    loadState: 'loaded',
    description: '',
    path: '',
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = (over: Record<string, any>): any => ({
    id: 'c1',
    names: ['c1'],
    image: '',
    state: 'running',
    status: 'Up',
    created: 0,
    ports: [],
    mounts: [],
    labels: {},
    networks: [],
    ...over,
  });

  const isServiceBayFor = (svc: unknown, ctr: unknown): boolean | undefined => {
    store.updateNode('node-x', { services: [svc as never], containers: [ctr as never] });
    return store.nodes['node-x'].services?.[0]?.isServiceBay;
  };

  it('does NOT flag the claude-dev container (servicebay-claude-dev image)', () => {
    const svc = service({ name: 'claude-dev.service', associatedContainerIds: ['cd'] });
    const ctr = container({
      id: 'cd',
      names: ['claude-dev-claude-dev'],
      image: 'ghcr.io/mdopp/servicebay-claude-dev:latest',
    });
    expect(isServiceBayFor(svc, ctr)).toBe(false);
  });

  it('DOES flag the real management image (servicebay) by image alone', () => {
    const svc = service({ name: 'sb.service', associatedContainerIds: ['mgmt'] });
    const ctr = container({
      id: 'mgmt',
      names: ['servicebay'],
      image: 'ghcr.io/mdopp/servicebay:latest',
    });
    expect(isServiceBayFor(svc, ctr)).toBe(true);
  });

  it('DOES flag the management unit by its name (servicebay.service)', () => {
    const svc = service({ name: 'servicebay.service' });
    const ctr = container({ id: 'other', names: ['other'], image: 'nginx:latest' });
    expect(isServiceBayFor(svc, ctr)).toBe(true);
  });
});
