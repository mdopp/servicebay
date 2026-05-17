/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkService } from '../../src/lib/network/service';
import { getConfig } from '../../src/lib/config';
import { DigitalTwinStore } from '../../src/lib/store/twin';

// Mock Config
vi.mock('../../src/lib/config', () => ({
    getConfig: vi.fn(),
    ExternalLink: {}
}));

vi.mock('../../src/lib/network/dns', () => ({
    checkDomains: vi.fn().mockResolvedValue([])
}));

// Mock Nodes
vi.mock('../../src/lib/nodes', () => ({
    listNodes: vi.fn().mockResolvedValue([])
}));

// Mock Twin Store (used in logic?)
vi.mock('../../src/lib/store/twin', () => {
    const twinStoreMock = {
        nodes: {
            'Local': {
                connected: true,
                initialSyncComplete: true,
                containers: [],
                services: [],
                files: {},
                lastSync: Date.now(),
                resources: {
                    network: {
                        eth0: [{ address: '192.168.178.99', family: 'IPv4', internal: false }]
                    }
                },
                volumes: [],
                proxyRoutes: []
            }
        },
        gateway: { upstreamStatus: 'up', publicIp: '1.2.3.4', internalIp: '192.168.1.1', portMappings: [] },
        getSnapshot: () => ({ nodes: {}, gateway: {}, proxyState: { routes: [] } })
    };

    return {
        DigitalTwinStore: {
            getInstance: () => twinStoreMock
        }
    };
});

// Mock FritzBox
vi.mock('../../src/lib/fritzbox/client', () => {
    class MockFritzBoxClient {
        async getStatus() {
            return {
                connected: true,
                externalIP: '1.2.3.4',
                uptime: 100
            };
        }
    }
    return {
        FritzBoxClient: MockFritzBoxClient
    };
});

// Mock ServiceManager (avoid real FS calls)
vi.mock('../../src/lib/services/ServiceManager', () => ({
    ServiceManager: {
        listServices: vi.fn().mockResolvedValue([])
    }
}));


describe('Network Graph Generation', () => {
    let service: NetworkService;

    beforeEach(() => {
        service = new NetworkService();
        (getConfig as any).mockResolvedValue({
            gateway: { host: 'fritz.box', type: 'fritzbox' },
            externalLinks: [
                { id: 'link1', name: 'Google', url: 'https://google.com', monitor: true, ipTargets: ['192.168.1.50:443'] }
            ]
        });

        const twinStore = DigitalTwinStore.getInstance() as any;
        twinStore.gateway.portMappings = [];
        const localNode = twinStore.nodes['Local'];
        localNode.connected = true;
        localNode.initialSyncComplete = true;
        localNode.services = [];
        localNode.containers = [];
        localNode.proxyRoutes = [];
        localNode.resources = {
            network: {
                eth0: [{ address: '192.168.178.99', family: 'IPv4', internal: false }]
            }
        };
    });

    it('should generate global infrastructure nodes (Internet, Router)', async () => {
        const graph = await service.getGraph('Local');
        
        const internet = graph.nodes.find(n => n.type === 'internet');
        const gateway = graph.nodes.find(n => n.id === 'gateway'); 

        expect(internet).toBeDefined();
        expect(gateway).toBeDefined();

        expect(gateway?.label).toBe('Gateway');
    });

    it('should generate external link nodes', async () => {
        const graph = await service.getGraph('Local');
        
        const linkNode = graph.nodes.find(n => n.id === 'link-link1');
        
        expect(linkNode).toBeDefined();
        expect(linkNode?.label).toBe('Google');
        // Implementation assigns type 'service' to external links
        expect(linkNode?.type).toBe('service');
        expect(linkNode?.rawData?.url).toBe('https://google.com');
        expect(linkNode?.metadata?.ipTargets).toEqual(['192.168.1.50:443']);
    });

    it('should connect router to internet', async () => {
        const graph = await service.getGraph('Local');
        
        // Service logic: edges.push({ source: 'internet', target: 'gateway', ... })
        const edge = graph.edges.find(e => e.source === 'internet' && e.target === 'gateway');
        expect(edge).toBeDefined();
    });

    it('should label gateway edges with forwarded ports from the twin', async () => {
        const twinStore = DigitalTwinStore.getInstance() as any;
        twinStore.gateway.portMappings = [
            { hostPort: 2010, containerPort: 2010, protocol: 'tcp', targetIp: '192.168.178.99' }
        ];

        const servicePort = { hostPort: 2010, containerPort: 3000, protocol: 'tcp', hostIp: '192.168.178.99' };
        twinStore.nodes['Local'].services = [{
            name: 'korgraph',
            activeState: 'active',
            subState: 'running',
            loadState: 'loaded',
            description: 'Korgraph',
            path: '/etc/systemd/system/korgraph.service',
            ports: [servicePort]
        }];

        const graph = await service.getGraph('Local');
        const edge = graph.edges.find((e) => e.source === 'gateway' && e.target.includes('service-korgraph'));

        expect(edge).toBeDefined();
        expect(edge?.label).toContain(':2010');
        expect(edge?.port).toBe(2010);
    });

    it('should surface unmanaged bundles as standalone service nodes', async () => {
        const twinStore = DigitalTwinStore.getInstance() as any;
        const localNode = twinStore.nodes['Local'];

        const unmanagedContainer = {
            id: 'abc123',
            names: ['/compose-app'],
            image: 'ghcr.io/example/app:latest',
            state: 'running',
            status: 'running',
            ports: [{ hostPort: 8080, containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0' }],
            labels: {},
            podName: null,
            podId: undefined,
            isInfra: false,
            networks: ['podman'],
            created: Date.now() / 1000
        };

        localNode.containers = [unmanagedContainer];
        localNode.services = [];
        localNode.unmanagedBundles = [{
            id: 'compose-app',
            displayName: 'compose-app',
            derivedName: 'compose-app',
            nodeName: 'Local',
            severity: 'warning',
            hints: [],
            validations: [],
            services: [],
            containers: [{
                id: 'abc123',
                name: 'compose-app',
                image: 'ghcr.io/example/app:latest',
                ports: [{ hostPort: 8080, containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0' }]
            }],
            ports: [{ hostPort: 8080, containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0' }],
            assets: [],
            graph: []
        }];

        const graph = await service.getGraph('Local');

        const bundleNode = graph.nodes.find(n => n.type === 'unmanaged-service');
        expect(bundleNode).toBeDefined();
        expect(bundleNode?.rawData?.name).toBe('compose-app');

        const unmanagedGroup = graph.nodes.find(n => n.id.includes('group-unmanaged-services'));
        expect(unmanagedGroup).toBeUndefined();
        expect(bundleNode?.parentNode).toBeUndefined();

        const containerNode = graph.nodes.find(n => n.id.includes('abc123'));
        expect(containerNode).toBeDefined();
        expect(containerNode?.parentNode).toBe(bundleNode?.id);
    });

    it('should connect proxy routes to services when targets use host IPs', async () => {
        const twinStore = DigitalTwinStore.getInstance() as any;
        const localNode = twinStore.nodes['Local'];

        localNode.proxyRoutes = [{
            host: 'app.korgraph.io',
            targetService: '192.168.178.99',
            targetPort: 2001,
            ssl: true
        }];

        localNode.services = [
            {
                name: 'nginx-web',
                active: true,
                isPrimaryProxy: true,
                associatedContainerIds: ['nginx-container'],
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
                proxyConfiguration: {
                    servers: [{
                        server_name: ['app.korgraph.io'],
                        listen: ['80'],
                        locations: [{ path: '/', proxy_pass: 'http://192.168.178.99:2001' }]
                    }]
                }
            },
            {
                name: 'korgraph',
                active: true,
                ports: [{ hostPort: 2001, containerPort: 2001, protocol: 'tcp', hostIp: '0.0.0.0' }],
                verifiedDomains: ['app.korgraph.io']
            }
        ];

        localNode.containers = [
            {
                id: 'nginx-container',
                names: ['/nginx-web'],
                labels: { 'servicebay.role': 'reverse-proxy' },
                state: 'running',
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }]
            },
            {
                id: 'korgraph-container',
                names: ['/korgraph'],
                state: 'running',
                ports: [{ hostPort: 2001, containerPort: 2001, protocol: 'tcp', hostIp: '0.0.0.0' }]
            }
        ];

        const graph = await service.getGraph('Local');
        const proxyEdge = graph.edges.find((e) =>
            e.source.includes('group-nginx') && e.target.includes('service-korgraph')
        );

        expect(proxyEdge).toBeDefined();
        expect(proxyEdge?.label).toBe(':2001');
    });

    it('should connect proxy routes directly to unmanaged bundles when containers lack services', async () => {
        const twinStore = DigitalTwinStore.getInstance() as any;
        const localNode = twinStore.nodes['Local'];

        localNode.proxyRoutes = [{
            host: 'vault.dopp.cloud',
            targetService: '192.168.178.99',
            targetPort: 8080,
            ssl: true
        }];

        localNode.services = [
            {
                name: 'nginx-web',
                active: true,
                isPrimaryProxy: true,
                associatedContainerIds: ['nginx-container'],
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
                proxyConfiguration: {
                    servers: [{
                        server_name: ['vault.dopp.cloud'],
                        listen: ['443 ssl', '80'],
                        locations: [{ path: '/', proxy_pass: 'http://192.168.178.99:8080' }]
                    }]
                }
            }
        ];

        localNode.containers = [
            {
                id: 'nginx-container',
                names: ['/nginx-web'],
                labels: { 'servicebay.role': 'reverse-proxy' },
                state: 'running',
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }]
            },
            {
                id: 'vault-container',
                names: ['/vaultwarden'],
                state: 'running',
                ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '192.168.178.99' }],
                labels: { 'io.podman.pod.name': 'pod_vaultwarden' }
            }
        ];

        localNode.unmanagedBundles = [{
            id: 'vault-bundle',
            displayName: 'Vaultwarden',
            derivedName: 'vault-bundle',
            nodeName: 'Local',
            severity: 'warning',
            hints: [],
            validations: [],
            services: [],
            containers: [{
                id: 'vault-container',
                name: 'vaultwarden',
                image: 'docker.io/vaultwarden/server:latest',
                ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '192.168.178.99' }]
            }],
            ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '192.168.178.99' }],
            assets: [],
            graph: []
        }];

        const graph = await service.getGraph('Local');
        const bundleNode = graph.nodes.find(n => n.type === 'unmanaged-service' && n.rawData?.name === 'Vaultwarden');
        expect(bundleNode).toBeDefined();
        const bundleDomains = (bundleNode?.metadata?.verifiedDomains || []) as string[];
        expect(bundleDomains).toContain('vault.dopp.cloud');

        const proxyEdge = graph.edges.find((e) =>
            e.source.includes('group-nginx') && e.target === bundleNode?.id
        );

        expect(proxyEdge).toBeDefined();
        expect(proxyEdge?.label).toBe(':8080');
    });

    it('should link proxy routes to configured external links when no managed service exists', async () => {
        (getConfig as any).mockResolvedValueOnce({
            gateway: { host: 'fritz.box', type: 'fritzbox' },
            externalLinks: [
                { id: 'ha', name: 'Home Assistant', url: 'https://home.dopp.cloud', monitor: false, ipTargets: ['192.168.178.98:8123'] }
            ]
        });

        const twinStore = DigitalTwinStore.getInstance() as any;
        const localNode = twinStore.nodes['Local'];

        localNode.proxyRoutes = [{
            host: 'home.dopp.cloud',
            targetService: '192.168.178.98',
            targetPort: 8123,
            ssl: true
        }];

        localNode.services = [
            {
                name: 'nginx-web',
                active: true,
                isPrimaryProxy: true,
                associatedContainerIds: ['nginx-container'],
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
                proxyConfiguration: {
                    servers: [{
                        server_name: ['home.dopp.cloud'],
                        listen: ['443 ssl', '80'],
                        locations: [{ path: '/', proxy_pass: 'https://192.168.178.98:8123' }]
                    }]
                }
            }
        ];

        localNode.containers = [
            {
                id: 'nginx-container',
                names: ['/nginx-web'],
                labels: { 'servicebay.role': 'reverse-proxy' },
                state: 'running',
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }]
            }
        ];

        const graph = await service.getGraph('Local');
        const linkNode = graph.nodes.find(n => n.id === 'link-ha');
        expect(linkNode).toBeDefined();

        const proxyEdge = graph.edges.find(e => e.source.includes('group-nginx') && e.target === 'link-ha');
        expect(proxyEdge).toBeDefined();
        expect(proxyEdge?.label).toBe(':8123');
    });

    it("should not list domains on the nginx node that are proxied to other services", async () => {
        // Reproduces the bug where bare-domain entries in containerUrlMapping
        // were being passed through `new URL(...)` (which throws on a hostname
        // without a scheme), the catch swallowed every domain, and the nginx
        // node ended up showing all externally-verified domains even when the
        // route actually targeted a different service.
        const dns = await import('../../src/lib/network/dns');
        (dns.checkDomains as any).mockResolvedValueOnce([
            { domain: 'photos.dopp.cloud', matches: true },
            { domain: 'nginx.dopp.cloud',  matches: true },
        ]);

        const twinStore = DigitalTwinStore.getInstance() as any;
        const localNode = twinStore.nodes['Local'];

        localNode.proxyRoutes = [];
        localNode.services = [
            {
                name: 'nginx-web',
                active: true,
                isPrimaryProxy: true,
                associatedContainerIds: ['nginx-container'],
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
                proxyConfiguration: {
                    servers: [
                        // photos.dopp.cloud → immich service (should NOT show on nginx)
                        {
                            server_name: ['photos.dopp.cloud'],
                            listen: ['443 ssl', '80'],
                            locations: [{ path: '/', proxy_pass: 'http://192.168.178.99:2283' }],
                        },
                        // nginx.dopp.cloud → nginx admin UI itself (SHOULD stay on nginx)
                        {
                            server_name: ['nginx.dopp.cloud'],
                            listen: ['443 ssl', '80'],
                            locations: [{ path: '/', proxy_pass: 'http://127.0.0.1:81' }],
                        },
                    ],
                },
            },
            {
                name: 'immich',
                active: true,
                ports: [{ hostPort: 2283, containerPort: 2283, protocol: 'tcp', hostIp: '0.0.0.0' }],
                associatedContainerIds: ['immich-container'],
            },
        ];
        localNode.containers = [
            {
                id: 'nginx-container',
                names: ['/nginx-web'],
                labels: { 'servicebay.role': 'reverse-proxy' },
                state: 'running',
                ports: [{ hostPort: 80, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
            },
            {
                id: 'immich-container',
                names: ['/immich-server'],
                state: 'running',
                ports: [{ hostPort: 2283, containerPort: 2283, protocol: 'tcp', hostIp: '0.0.0.0' }],
            },
        ];

        const graph = await service.getGraph('Local');
        const nginxNode = graph.nodes.find(n => n.id.includes('group-nginx'));
        expect(nginxNode).toBeDefined();

        const verified = (nginxNode!.metadata?.verifiedDomains ?? []) as string[];
        const allVerified = (nginxNode!.metadata?.allVerifiedDomains ?? []) as string[];

        // Filtered list: only domains nginx itself serves, not what it proxies elsewhere.
        expect(verified).not.toContain('photos.dopp.cloud');
        // Loopback admin route should survive — that *is* nginx's own UI.
        expect(verified).toContain('nginx.dopp.cloud');
        // Unfiltered backup is still around for the side panel.
        expect(allVerified).toContain('photos.dopp.cloud');
        expect(allVerified).toContain('nginx.dopp.cloud');

        // The proxied domain should land on its real service instead.
        const immichNode = graph.nodes.find(n => n.id.includes('service-immich'));
        const immichDomains = (immichNode?.metadata?.verifiedDomains ?? []) as string[];
        expect(immichDomains).toContain('photos.dopp.cloud');
    });
});
