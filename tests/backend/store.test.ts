 

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';

describe('DigitalTwinStore', () => {
    let store: DigitalTwinStore;

    beforeEach(() => {
        // Reset singleton (needs casting if private, or just getting instance)
        // Since it's a singleton, state might persist. We need to clear it.
        store = DigitalTwinStore.getInstance();
        store.nodes = {};
        store.gateway = {
            provider: 'mock',
            publicIp: '0.0.0.0',
            upstreamStatus: 'down',
            lastUpdated: 0
        };
    });

    it('should be a singleton', () => {
        const s1 = DigitalTwinStore.getInstance();
        const s2 = DigitalTwinStore.getInstance();
        expect(s1).toBe(s2);
    });

    it('should register a new node', () => {
        store.registerNode('TestNode');
        expect(store.nodes['TestNode']).toBeDefined();
        expect(store.nodes['TestNode'].connected).toBe(false);
    });

    it('should update node data and timestamp', () => {
        store.registerNode('Node1');
        const before = Date.now();
        
        store.updateNode('Node1', { connected: true });
        
        expect(store.nodes['Node1'].connected).toBe(true);
        expect(store.nodes['Node1'].lastSync).toBeGreaterThanOrEqual(before);
    });

    it('should notify listeners on update', () => {
        const spy = vi.fn();
        const unsubscribe = store.subscribe(spy);

        store.registerNode('Node1');
        expect(spy).toHaveBeenCalledTimes(1);

        store.updateNode('Node1', { connected: true });
        expect(spy).toHaveBeenCalledTimes(2);

        unsubscribe();
        store.updateNode('Node1', { connected: false });
        expect(spy).toHaveBeenCalledTimes(2); // No new call
    });

    it('should update gateway state', () => {
        store.updateGateway({ publicIp: '1.2.3.4', upstreamStatus: 'up' });
        expect(store.gateway.publicIp).toBe('1.2.3.4');
        expect(store.gateway.upstreamStatus).toBe('up');
        expect(store.gateway.lastUpdated).toBeGreaterThan(0);
    });
});
