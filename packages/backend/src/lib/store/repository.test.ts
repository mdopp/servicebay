import { describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinStore } from './twin';
import {
  getNodeTwins,
  getNodeTwin,
  getContainers,
  getServices,
  getGateway,
  getProxyState,
  getStoreSnapshot,
} from './repository';

describe('Store Repository Selectors', () => {
  let store: DigitalTwinStore;

  beforeEach(() => {
    store = DigitalTwinStore.getInstance();
    // Clear/reset nodes for testing
    store.nodes = {};
    store.gateway = {
      provider: 'mock',
      publicIp: '1.2.3.4',
      upstreamStatus: 'up',
      lastUpdated: Date.now(),
    };
    store.proxyState = {
      provider: 'nginx',
      routes: [],
    };
  });

  it('getNodeTwins should return all nodes', () => {
    expect(getNodeTwins()).toEqual({});
    store.registerNode('node1');
    expect(getNodeTwins()).toHaveProperty('node1');
  });

  it('getNodeTwin should return a specific node twin or undefined', () => {
    expect(getNodeTwin('node1')).toBeUndefined();
    store.registerNode('node1');
    expect(getNodeTwin('node1')).toBeDefined();
    expect(getNodeTwin('node1')?.connected).toBe(false);
  });

  it('getContainers should return node containers', () => {
    store.registerNode('node1');
    expect(getContainers('node1')).toEqual([]);
    store.nodes['node1'].containers = [
      { id: 'c1', name: 'container1', names: ['container1'], podName: 'pod1', labels: {}, status: 'running', image: 'nginx', ports: [] },
    ];
    expect(getContainers('node1')).toHaveLength(1);
    expect(getContainers('node1')[0].id).toBe('c1');
  });

  it('getServices should return node services', () => {
    store.registerNode('node1');
    expect(getServices('node1')).toEqual([]);
    store.nodes['node1'].services = [
      { name: 'service1', active: true, status: 'active' },
    ];
    expect(getServices('node1')).toHaveLength(1);
    expect(getServices('node1')[0].name).toBe('service1');
  });

  it('getGateway should return gateway state', () => {
    expect(getGateway().publicIp).toBe('1.2.3.4');
  });

  it('getProxyState should return proxy state', () => {
    expect(getProxyState().provider).toBe('nginx');
  });

  it('getStoreSnapshot should return a snapshot', () => {
    store.registerNode('node1');
    const snap = getStoreSnapshot();
    expect(snap.nodes).toHaveProperty('node1');
  });
});
