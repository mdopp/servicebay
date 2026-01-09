/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';

describe('DigitalTwinStore Robustness', () => {
    let store: DigitalTwinStore;

    beforeEach(() => {
        // Reset Singleton ? 
        // It's a global singleton, so we might need to reset it manually.
        store = DigitalTwinStore.getInstance();
        store.nodes = {}; // Clear nodes
    });

    it('should ignore invalid container updates', () => {
        store.registerNode('TestNode');
        
        // @ts-expect-error
        store.updateNode('TestNode', { containers: "Not Array" });
        
        const node = store.nodes['TestNode'];
        // Should remain empty array (default) or at least NOT be a string
        expect(Array.isArray(node.containers)).toBe(true);
    });
    
    it('should ignore null services update', () => {
        store.registerNode('TestNode');
        
        // @ts-expect-error
        store.updateNode('TestNode', { services: null });
        
        const node = store.nodes['TestNode'];
        expect(Array.isArray(node.services)).toBe(true);
    });

    it('should accept valid updates', () => {
        store.registerNode('TestNode');
        store.updateNode('TestNode', { containers: [{ id: '1' } as any] });
        expect(store.nodes['TestNode'].containers.length).toBe(1);
    });
});
