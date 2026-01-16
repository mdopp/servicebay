import { describe, it, expect } from 'vitest';
import { buildServiceBundlesForNode } from '@/lib/unmanaged/bundleBuilder';
import type { ServiceUnit } from '@/lib/agent/types';

describe('Quadlet Directive Parsing', () => {
  it('should parse Requires and After directives from immich-server.container', () => {
    // Simulate what the agent should send for immich-server.container
    const immichServerService: ServiceUnit = {
      name: 'immich-server',
      activeState: 'active',
      subState: 'running',
      loadState: 'loaded',
      description: 'Immich Server',
      path: '/run/user/1000/systemd/generator.run/immich-server.service',
      fragmentPath: '/home/mdopp/.config/containers/systemd/immich-server.container',
      isManaged: false,
      isPrimaryProxy: false,
      isReverseProxy: false,
      isServiceBay: false,
      associatedContainerIds: [],
      ports: [],
      // From parsing immich-server.container file:
      requires: ['immich-redis.service', 'immich-database.service'],
      after: ['immich-redis.service', 'immich-database.service'],
      wants: [],
      bindsTo: [],
      podReference: 'immich',
      publishedPorts: [],
      quadletSourceType: 'container',
      active: true,
      verifiedDomains: [],
      effectiveHostNetwork: false,
      proxyConfiguration: null
    };

    const immichRedisService: ServiceUnit = {
      name: 'immich-redis',
      activeState: 'active',
      subState: 'running',
      loadState: 'loaded',
      description: 'Immich Redis',
      path: '/run/user/1000/systemd/generator.run/immich-redis.service',
      fragmentPath: '/home/mdopp/.config/containers/systemd/immich-redis.container',
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
      podReference: 'immich',
      publishedPorts: [],
      quadletSourceType: 'container',
      active: true,
      verifiedDomains: [],
      effectiveHostNetwork: false,
      proxyConfiguration: null
    };

    const immichDatabaseService: ServiceUnit = {
      name: 'immich-database',
      activeState: 'active',
      subState: 'running',
      loadState: 'loaded',
      description: 'Immich Database',
      path: '/run/user/1000/systemd/generator.run/immich-database.service',
      fragmentPath: '/home/mdopp/.config/containers/systemd/immich-database.container',
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
      podReference: 'immich',
      publishedPorts: [],
      quadletSourceType: 'container',
      active: true,
      verifiedDomains: [],
      effectiveHostNetwork: false,
      proxyConfiguration: null
    };

    const services = [immichServerService, immichRedisService, immichDatabaseService];

    const bundles = buildServiceBundlesForNode({
      nodeName: 'atHome',
      services,
      containers: [],
      files: {}
    });

    // Should create 1 bundle (all services are related via Requires)
    expect(bundles.length).toBe(1);

    const bundle = bundles[0];

    // Should include all three services
    expect(bundle.services.length).toBe(3);
    expect(bundle.services.map(s => s.serviceName).sort()).toEqual([
      'immich-database',
      'immich-redis',
      'immich-server'
    ]);

    // Should have graph edges for Requires and After
    const requiresEdges = bundle.graph.filter(e => e.reason === 'Requires');
    expect(requiresEdges.length).toBeGreaterThan(0);

    const afterEdges = bundle.graph.filter(e => e.reason === 'After');
    expect(afterEdges.length).toBeGreaterThan(0);

    // Should have discovery log showing all services were found
    expect(bundle.discoveryLog).toBeDefined();
    expect(bundle.discoveryLog?.some(log => log.includes('Dependency graph walk found 3 related service'))).toBe(true);

    // Should show hints about relationships
    const hints = bundle.hints;
    expect(hints.some(h => h.includes('Hard dependencies'))).toBe(true);
    expect(hints.some(h => h.includes('Ordered after'))).toBe(true);
  });
});
