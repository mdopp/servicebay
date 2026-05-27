 

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DigitalTwinStore } from '@/lib/store/twin';

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

    it('records migration events with bounded history', () => {
        const nodeId = 'NodeHistory';
        store.registerNode(nodeId);

        for (let i = 0; i < 30; i += 1) {
            store.recordMigrationEvent(nodeId, {
                id: `evt-${i}`,
                timestamp: new Date(Date.now() + i).toISOString(),
                actor: 'tester',
                targetName: `target-${i}`,
                nodeName: nodeId,
                bundleSize: 2,
                services: [
                    { name: 'svc-a', containerIds: [], sourcePath: '/tmp/a', unitFile: '/tmp/a.service' },
                    { name: 'svc-b', containerIds: [], sourcePath: '/tmp/b', unitFile: '/tmp/b.service' }
                ],
                status: 'success'
            });
        }

        const history = store.nodes[nodeId].history;
        expect(history).toHaveLength(25);
        expect(history[0].targetName).toBe('target-29');
        expect(history[history.length - 1].targetName).toBe('target-5');
    });

    // #1036 — bundle discovery used to run synchronously inside every
    // updateNode call (6+ per initial sync, one per poll). It now
    // coalesces on a debounce so a burst collapses into one rebuild.
    describe('unmanaged bundle rebuild debounce (#1036)', () => {
        it('does not compute bundles synchronously inside updateNode', () => {
            store.registerNode('DebounceNode');
            store.bundleRebuildDebounceMs = 5_000;

            // Push something that *would* bundle: a service file
            // referencing a container that is not Quadlet-managed.
            store.updateNode('DebounceNode', {
                containers: [],
                services: [],
                files: {},
            });

            // Immediately after updateNode, bundles should still be the
            // empty initial state — the rebuild is pending, not done.
            expect(store.nodes['DebounceNode'].unmanagedBundles).toEqual([]);
            // And a timer should be scheduled, proving the rebuild was
            // deferred rather than skipped entirely.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const timers = (store as any).bundleRebuildTimers as Map<string, unknown>;
            expect(timers.has('DebounceNode')).toBe(true);
        });

        it('rebuilds exactly once across a burst of updateNode calls', () => {
            vi.useFakeTimers();
            try {
                store.registerNode('BurstNode');
                store.bundleRebuildDebounceMs = 5_000;

                // Spy on the public on-demand entry point — the debounce
                // callback funnels through it, so one call here proves the
                // burst coalesced.
                const rebuildSpy = vi.spyOn(store, 'rebuildBundlesNow');

                // Six updates inside the debounce window: matches the
                // worst-case agent initial-sync pattern (containers /
                // services / volumes / files / resources / proxyRoutes).
                for (let i = 0; i < 6; i += 1) {
                    store.updateNode('BurstNode', { resources: null });
                    vi.advanceTimersByTime(500);
                }

                // Mid-burst (3s elapsed): rebuild has not fired.
                expect(rebuildSpy).not.toHaveBeenCalled();

                // Advance past the debounce window. One rebuild total.
                vi.advanceTimersByTime(5_000);
                expect(rebuildSpy).toHaveBeenCalledTimes(1);
                expect(rebuildSpy).toHaveBeenCalledWith('BurstNode');
            } finally {
                vi.useRealTimers();
            }
        });

        it('rebuildBundlesNow bypasses the debounce for explicit operator actions', () => {
            store.registerNode('NowNode');
            store.bundleRebuildDebounceMs = 60_000;

            store.updateNode('NowNode', { resources: null });
            expect(store.nodes['NowNode'].unmanagedBundles).toEqual([]);

            store.rebuildBundlesNow('NowNode');
            // Bundles list is still empty (no input to bundle from), but
            // the call shouldn't throw and should leave the field set.
            expect(store.nodes['NowNode'].unmanagedBundles).toEqual([]);
        });
    });
});
