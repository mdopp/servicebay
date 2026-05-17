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
});
