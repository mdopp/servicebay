/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';
import { EnrichedContainer, ServiceUnit } from '../../src/lib/agent/types';

describe('DigitalTwinStore Data Flow', () => {
  let store: DigitalTwinStore;

  beforeEach(() => {
    // Reset store
    // Since it's a singleton, we might need to access the private instance or just rely on overwrite.
    // Ideally we should have a reset method for testing.
    store = DigitalTwinStore.getInstance();
    store.nodes = {}; // Manual reset
  });

  it('should persist ports from Agent ServiceUnit payload', () => {
    // 1. Simulate Agent Payload (Output of agent.py)
    const agentServicePayload: ServiceUnit = {
      name: 'adguard-home',
      active: true,
      subState: 'running',
      ports: [
        { host_port: 53, container_port: 53, protocol: 'tcp' }
      ],
      associatedContainerIds: ['cid1'],
      isManaged: true,
      activeState: 'active',
      isReverseProxy: false,
      isServiceBay: false,
      path: '/path/to/kube',
      loadState: 'loaded',
      description: 'AdGuard Home'
    };

    const agentContainerPayload: EnrichedContainer = {
      id: 'cid1',
      names: ['adguard-home'],
      image: 'adguard/adguardhome',
      state: 'running',
      status: 'Up',
      created: 12345,
      ports: [
        { host_port: 53, container_port: 53, protocol: 'tcp' }
      ],
      mounts: [],
      labels: {},
      networks: ['host'],
      isHostNetwork: true,
      podId: '',
      podName: '',
      isInfra: false,
      pid: 123
    };

    // 2. Update Store
    store.updateNode('TestNode', {
      connected: true,
      services: [agentServicePayload],
      containers: [agentContainerPayload]
    });

    // 3. Verify Store State
    const node = store.nodes['TestNode'];
    expect(node).toBeDefined();
    
    // Check Service Ports (Primary Path)
    const svc = node.services[0];
    expect(svc.ports!).toHaveLength(1);
    expect(svc.ports![0].hostPort).toBe(53);
    
    // Check Container Ports (Secondary Path)
    const ctr = node.containers[0];
    expect(ctr.ports).toHaveLength(1);
    expect(ctr.ports[0].hostPort).toBe(53);
    
    // Check Linkage
    // agent.py sends associatedContainerIds, store might merge/dedupe
    expect(svc.associatedContainerIds).toContain('cid1');
  });

  it('should link Service to Container if Agent misses it but Names match', () => {
     // Verify the Store's fallback logic
     // Scenario: Agent sends Service without ID, but Container matches name
     const service: ServiceUnit = {
         name: 'nginx',
         active: true,
         // Missing ports and association from Agent side (e.g. old agent)
         ports: [],
         associatedContainerIds: [],
         activeState: 'active',
         subState: 'running',
         isManaged: true,
         isReverseProxy: false,
         isServiceBay: false,
         path: '',
         loadState: 'loaded',
         description: 'Nginx Service'
     };
     
     const container: EnrichedContainer = {
         id: 'nginx-cid',
         names: ['nginx'], // Matching name
         ports: [{ host_port: 80, container_port: 80, protocol: 'tcp' }],
         image: 'nginx',
         state: 'running',
         status: 'up',
         created: 0,
         mounts: [],
         labels: {},
         networks: [],
         isHostNetwork: false,
         podId: '',
         podName: '',
         isInfra: false,
         pid: 100
     };

     store.updateNode('LinkTest', {
         services: [service],
         containers: [container]
     });

     const svc = store.nodes['LinkTest'].services[0];
     // Store logic should have detected the name match and updated associatedContainerIds
     expect(svc.associatedContainerIds).toContain('nginx-cid');
  });

  it('should enrich Primary Proxy service with Nginx Configuration from Agent Proxy Routes', () => {
      // 1. Setup Data: Proxy Routes + Nginx Service
      const proxyRoutes = [
          { host: 'app.example.com', targetService: 'http://127.0.0.1:3000', ssl: true, targetPort: 3000 },
          { host: 'api.example.com', targetService: 'http://127.0.0.1:4000', ssl: false, targetPort: 4000 }
      ];

      const nginxService: ServiceUnit = {
          name: 'nginx-web',
          active: true,
          activeState: 'active',
          subState: 'running',
          loadState: 'loaded',
          description: 'Nginx Proxy',
          path: '/etc/systemd/system/nginx-web.service',
          isReverseProxy: true,
          isManaged: true,
          // Initially empty
          ports: [],
          isPrimaryProxy: false // Should be set by Store
      };

      // 2. Update Store
      store.updateNode('ProxyTest', {
          connected: true,
          services: [nginxService],
          containers: [], 
          proxy: proxyRoutes
      });

      // 3. Verify Enrichment
      const node = store.nodes['ProxyTest'];
      const enrichedService = node.services[0];

      // A. Check Primary Proxy Selection
      expect(enrichedService.isPrimaryProxy).toBe(true);

      // B. Check Proxy Configuration (The new source of truth)
      expect(enrichedService.proxyConfiguration).toBeDefined();
      expect(enrichedService.proxyConfiguration.servers).toHaveLength(2);
      
      const server1 = enrichedService.proxyConfiguration.servers.find((s: any) => s.server_name.includes('app.example.com'));
      expect(server1).toBeDefined();
      expect(server1.listen).toContain('443 ssl'); // SSL enabled
      
      const server2 = enrichedService.proxyConfiguration.servers.find((s: any) => s.server_name.includes('api.example.com'));
      expect(server2).toBeDefined();
      expect(server2.listen).toContain('80'); // No SSL

      // C. Check Effective Ports (Should be derived from routes)
      // Expect 80 and 443 because at least one route has SSL and one has 80
      expect(enrichedService.ports).toBeDefined();
      const ports = enrichedService.ports!;
      expect(ports.some(p => p.hostPort === 80)).toBe(true);
      expect(ports.some(p => p.hostPort === 443)).toBe(true);

      // D. Check Global Proxy Aggregation (TwinStore Property)
      // This powers Verified Domains usage in frontend
      expect(store.proxy.routes).toHaveLength(2);
      expect(store.proxy.routes.find(r => r.host === 'app.example.com')).toBeDefined();
  });

  it('should back-link Verified Domains to Services based on Target IP:Port', () => {
      // 1. Setup Proxy Node (Defines Route)
      const proxyRoutes = [
          { host: 'myapp.local', targetService: '192.168.1.50:8080', ssl: false, targetPort: 8080 }
      ];
      store.updateNode('ProxyNode', {
           connected: true,
           proxy: proxyRoutes,
           services: [], containers: []
      });

      // 2. Setup App Node (Runs Service)
      const appService: ServiceUnit = {
          name: 'myapp',
          activeState: 'active',
          subState: 'running',
          loadState: 'loaded',
          description: 'My App',
          path: '',
          active: true,
          ports: [{ host_port: 8080, container_port: 8080, protocol: 'tcp' }],
          isManaged: true,
          isReverseProxy: false,
          isServiceBay: false
      };
      
      // Inject Node IP into Resources
      store.updateNode('AppNode', {
          connected: true,
          services: [appService],
          containers: [],
          resources: {
              cpuUsage: 0, memoryUsage: 0, totalMemory: 0, diskUsage: 0,
              network: {
                  'eth0': [{ address: '192.168.1.50', family: 'IPv4', internal: false }]
              }
          }
      });
      
      // 3. Verify Back-linking
      // The update to AppNode should trigger recalculateGlobalProxy -> mapDomainsToServices
      // But since ProxyNode registered the route, the global proxy state is already set.
      // mapDomainsToServices iterates ALL nodes. So AppNode should be enriched.
      
      const enrichedApp = store.nodes['AppNode'].services[0];
      expect(enrichedApp.verifiedDomains).toBeDefined();
      expect(enrichedApp.verifiedDomains).toContain('myapp.local');
  });
});
