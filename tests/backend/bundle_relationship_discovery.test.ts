import { describe, it, expect } from 'vitest';
import { buildServiceBundlesForNode } from '@/lib/unmanaged/bundleBuilder';
import type { ServiceUnit } from '@/lib/agent/types';

describe('Bundle Relationship Discovery', () => {
  it('should create graph edges from discovered Quadlet relationships', () => {
    // Create mock services with discovered relationships
    const services: ServiceUnit[] = [
      {
        name: 'immich-server',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Server',
        path: '/',
        fragmentPath: '/home/user/.config/systemd/user/immich-server.service',
        isManaged: false,
        isPrimaryProxy: false,
        isReverseProxy: false,
        isServiceBay: false,
        associatedContainerIds: [],
        ports: [],
        // Discovered Quadlet relationships
        requires: ['immich-database.service'],
        after: ['immich-redis.service'],
        wants: ['immich-machine-learning.service'],
        bindsTo: [],
        podReference: undefined,
        publishedPorts: [],
        quadletSourceType: 'service',
        active: true,
        verifiedDomains: [],
        effectiveHostNetwork: false,
        proxyConfiguration: null
      },
      {
        name: 'immich-database',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Database',
        path: '/',
        fragmentPath: '/home/user/.config/systemd/user/immich-database.service',
        isManaged: false,
        isPrimaryProxy: false,
        isReverseProxy: false,
        isServiceBay: false,
        associatedContainerIds: [],
        ports: [],
        requires: [],
        after: [],
        wants: [],
        bindsTo: [],
        podReference: undefined,
        publishedPorts: [],
        quadletSourceType: 'service',
        active: true,
        verifiedDomains: [],
        effectiveHostNetwork: false,
        proxyConfiguration: null
      },
      {
        name: 'immich-redis',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Redis',
        path: '/',
        fragmentPath: '/home/user/.config/systemd/user/immich-redis.service',
        isManaged: false,
        isPrimaryProxy: false,
        isReverseProxy: false,
        isServiceBay: false,
        associatedContainerIds: [],
        ports: [],
        requires: [],
        after: [],
        wants: [],
        bindsTo: [],
        podReference: undefined,
        publishedPorts: [],
        quadletSourceType: 'service',
        active: true,
        verifiedDomains: [],
        effectiveHostNetwork: false,
        proxyConfiguration: null
      }
    ];

    const bundles = buildServiceBundlesForNode({
      nodeName: 'local',
      services,
      containers: [],
      files: {}
    });

    // Should create 1 bundle (all services are related)
    expect(bundles.length).toBe(1);
    
    const bundle = bundles[0];
    
    // Should include all three services
    expect(bundle.services.map(s => s.serviceName).sort()).toEqual([
      'immich-database',
      'immich-redis',
      'immich-server'
    ]);

    // Check for graph edges from discovered relationships
    const graphEdges = bundle.graph;
    
    // Should have edges for: Requires, After, Wants
    expect(graphEdges).toContainEqual({
      from: 'immich-server',
      to: 'immich-database.service',
      reason: 'Requires'
    });
    
    expect(graphEdges).toContainEqual({
      from: 'immich-server',
      to: 'immich-redis.service',
      reason: 'After'
    });
    
    expect(graphEdges).toContainEqual({
      from: 'immich-server',
      to: 'immich-machine-learning.service',
      reason: 'Wants'
    });

    // Should have hints about the relationships
    const hints = bundle.hints;
    expect(hints.some(h => h.includes('Hard dependencies'))).toBe(true);
    expect(hints.some(h => h.includes('Ordered after'))).toBe(true);
    expect(hints.some(h => h.includes('Soft dependencies'))).toBe(true);
  });

  it('should create graph edges from bindsTo relationships', () => {
    const services: ServiceUnit[] = [
      {
        name: 'pod-container',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Pod Container',
        path: '/',
        fragmentPath: '/home/user/.config/systemd/user/pod-container.service',
        isManaged: false,
        isPrimaryProxy: false,
        isReverseProxy: false,
        isServiceBay: false,
        associatedContainerIds: [],
        ports: [],
        requires: [],
        after: [],
        wants: [],
        bindsTo: ['mypod.pod'],
        podReference: undefined,
        publishedPorts: [],
        quadletSourceType: 'service',
        active: true,
        verifiedDomains: [],
        effectiveHostNetwork: false,
        proxyConfiguration: null
      }
    ];

    const bundles = buildServiceBundlesForNode({
      nodeName: 'local',
      services,
      containers: [],
      files: {}
    });

    expect(bundles.length).toBe(1);
    const bundle = bundles[0];
    
    // Check for BindsTo edge
    expect(bundle.graph).toContainEqual({
      from: 'pod-container',
      to: 'mypod.pod',
      reason: 'BindsTo'
    });
    
    // Should have hint about binding relationship
    expect(bundle.hints.some(h => h.includes('Binding relationships'))).toBe(true);
  });
});
