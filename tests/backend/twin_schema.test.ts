import { describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';

beforeEach(() => {
  // Reset the singleton so each test sees a clean slate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__DIGITAL_TWIN__ = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DigitalTwinStore as any).instance = undefined;
});

describe('DigitalTwinStore.updateNode validated entry point', () => {
  it('drops non-array containers and keeps the rest', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateNode('TestNode', { containers: 'oops' as any, services: [] as any });
    const node = store.nodes['TestNode'];
    expect(Array.isArray(node.containers)).toBe(true);
    expect(node.containers.length).toBe(0);
  });

  it('drops non-object files', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateNode('TestNode', { files: 'nope' as any });
    expect(store.nodes['TestNode'].files).toEqual({});
  });

  it('accepts a valid empty update without errors', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    expect(() => store.updateNode('TestNode', {})).not.toThrow();
  });

  it('accepts well-formed arrays', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateNode('TestNode', { containers: [], services: [], proxyRoutes: [], history: [] } as any);
    const node = store.nodes['TestNode'];
    expect(node.containers).toEqual([]);
    expect(node.services).toEqual([]);
  });

  // Regression: #593 renamed agent SYNC_PARTIAL key `proxy` → `proxyRoutes`
  // but agent.py:2211 was missed (pushed under the old `proxy` key for
  // every post-install scan) AND schema.ts kept the old `proxy` field
  // instead of switching to `proxyRoutes`. Combined effect: NPM routes
  // never made it into the twin, so /api/services lost
  // `verifiedDomains`/`proxyConfiguration` and the network map showed
  // no proxy edges. No test caught it because there was no roundtrip
  // for proxyRoutes specifically — only the array-shape sanity check.
  it('persists proxyRoutes from a SYNC_PARTIAL payload and aggregates them globally', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    store.setNodeConnection('TestNode', true);
    const route = { host: 'app.example.com', targetService: '192.168.1.10', targetPort: 8080, ssl: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateNode('TestNode', { proxyRoutes: [route] } as any);

    // Per-node persistence — the field the readers (serviceListing,
    // recalculateGlobalProxy) actually look at.
    expect(store.nodes['TestNode'].proxyRoutes).toEqual([route]);
    // Global aggregation — what /api/services flattens onto nginx's
    // `proxyConfiguration.servers` and what `mapDomainsToServices`
    // back-fills as `verifiedDomains` on the target service.
    expect(store.proxyState.routes).toEqual([route]);
  });

  it('ignores the legacy `proxy` key (removed in #593) — would otherwise re-introduce the silent drop', () => {
    const store = DigitalTwinStore.getInstance();
    store.registerNode('TestNode');
    store.setNodeConnection('TestNode', true);
    const route = { host: 'app.example.com', targetService: 'svc', targetPort: 80, ssl: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateNode('TestNode', { proxy: [route] } as any);

    // The legacy key must NOT populate proxyRoutes — that's what made
    // the agent.py:2211 typo silently break the entire reverse-proxy
    // view. If a future refactor accidentally accepts both keys, this
    // test fires.
    expect(store.nodes['TestNode'].proxyRoutes ?? []).toEqual([]);
    expect(store.proxyState.routes).toEqual([]);
  });
});
