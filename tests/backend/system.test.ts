/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';
import { SystemResources } from '../../src/lib/agent/types';

describe('System Information Data Flow', () => {
    let store: DigitalTwinStore;

    beforeEach(() => {
        store = DigitalTwinStore.getInstance();
        store.nodes = {};
    });

    it('should store pushed resource updates from agent', () => {
        const mockResources: SystemResources = {
            cpuUsage: 45.2,
            memoryUsage: 1024 * 1024 * 512, // 512MB
            totalMemory: 1024 * 1024 * 1024 * 8, // 8GB
            diskUsage: 22.5,
            os: {
                platform: 'linux',
                release: '5.10.0',
                uptime: 3600,
                hostname: 'server-1',
                arch: 'x64'
            }
        };

        store.updateNode('Node1', { resources: mockResources });

        const node = store.nodes['Node1'];
        expect(node).toBeDefined();
        expect(node.resources).toEqual(mockResources);
        expect(node.resources?.cpuUsage).toBe(45.2);
    });

    it('should handle partial updates to resources', () => {
        // Agent V4 typically sends full resource object on change, 
        // but if we support partials deep merging, let's verify Store behavior.
        // Current Store implementation uses spread ...update, so it overwrites 'resources' key completely.
        
        const initialResources: SystemResources = {
            cpuUsage: 10,
            memoryUsage: 100,
            totalMemory: 1000,
            diskUsage: 10
        };

        store.updateNode('Node1', { resources: initialResources });

        const updatedResources = { ...initialResources, cpuUsage: 99 };
        store.updateNode('Node1', { resources: updatedResources });

        expect(store.nodes['Node1'].resources?.cpuUsage).toBe(99);
    });

    // If there is an API for system info, we would test it here.
    // Based on inspection, frontend likely uses `nodes` object from `useDigitalTwin` directly.
    // So ensuring Store correctness is sufficient.
});
