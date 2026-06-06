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
