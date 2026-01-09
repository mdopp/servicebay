/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkService } from '../../src/lib/network/service';
import { getConfig } from '../../src/lib/config';

// Mock Config
vi.mock('../../src/lib/config', () => ({
    getConfig: vi.fn(),
    ExternalLink: {}
}));

// Mock Nodes
vi.mock('../../src/lib/nodes', () => ({
    listNodes: vi.fn().mockResolvedValue([])
}));

// Mock Twin Store (used in logic?)
vi.mock('../../src/lib/store/twin', () => ({
    DigitalTwinStore: {
        getInstance: () => ({
            nodes: {
                'Local': {
                    connected: true,
                    containers: [],
                    services: [],
                    files: {},
                    lastSync: Date.now(),
                    resources: {},
                    volumes: [],
                    proxy: []
                }
            },
            getSnapshot: () => ({ nodes: {}, gateway: {}, proxy: { routes: [] } })
        })
    }
}));

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
                { id: 'link1', name: 'Google', url: 'https://google.com', monitor: true }
            ]
        });
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
        
        // NetworkService prefixes external links with 'ext-' and uses name as ID suffix
        const linkNode = graph.nodes.find(n => n.id === 'ext-Google');
        
        expect(linkNode).toBeDefined();
        expect(linkNode?.label).toBe('Google');
        // Implementation assigns type 'service' to external links
        expect(linkNode?.type).toBe('service');
    });

    it('should connect router to internet', async () => {
        const graph = await service.getGraph('Local');
        
        // Service logic: edges.push({ source: 'internet', target: 'gateway', ... })
        const edge = graph.edges.find(e => e.source === 'internet' && e.target === 'gateway');
        expect(edge).toBeDefined();
    });
});
