'use client';

import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { useSocket } from '@/hooks/useSocket';
import type { NodeTwin, GatewayState, ProxyState } from '@servicebay/api-client';
import { logger } from '@servicebay/api-client';

export interface DigitalTwinSnapshot {
  instanceId?: string;
  serverName?: string | null;
  // #1733: base names ServiceBay installed (config.installedTemplates keys);
  // lets the service view treat a single-container .container Quadlet (no pod)
  // as managed rather than a Standalone container.
  installedTemplates?: string[];
  nodes: Record<string, NodeTwin>;
  gateway: GatewayState;
  proxyState: ProxyState;
}

interface DigitalTwinContextType {
    data: DigitalTwinSnapshot | null;
    isConnected: boolean;
    lastUpdate: number;
    isNodeSynced: (nodeName?: string) => boolean;
}

const DigitalTwinContext = createContext<DigitalTwinContextType | undefined>(undefined);

// #2736 — the global `window.fetch` monkey-patch that used to live here (an
// import-time side effect of loading this module) is GONE. It intercepted 401s
// for every fetch on the page, which made the 401 contract invisible: a raw
// `fetch('/api/...')` inherited session-expiry handling by accident, so nothing
// ever pushed call sites onto the real seam and the raw-fetch count grew.
//
// The single 401 → /login handler is now `apiFetch` in @servicebay/api-client
// (the same pathname guard, the same own-/api/-URL check, opt-in per call). The
// socket transport's `unauthorized` handler in hooks/useSocket.ts shares that
// module's `isAnonymousPathname` rather than a second copy of the path set.
//
// Migrating the remaining raw call sites is ratchet work: the ESLint rule
// `sb/no-raw-api-fetch` counts them and `scripts/check-lint-ratchet.ts` forbids
// the count from rising.

export function DigitalTwinProvider({ children }: { children: ReactNode }) {
    const { socket, isConnected } = useSocket();
    const [data, setData] = useState<DigitalTwinSnapshot | null>(null);
    const [lastUpdate, setLastUpdate] = useState<number>(0);
    const instanceIdRef = useRef<string | null>(null);

    // Persist data across unmounts is automatic because this Provider is at root.

    useEffect(() => {
        if (!socket) return;

        const handleUpdate = (snapshot: DigitalTwinSnapshot) => {
            // Option: If we want to optimize, we can merge diffs here if the server sends diffs.
            // But currently it seems to send full snapshots or we just replace common parts.
            // The previous hook just did setData(snapshot).
            if (instanceIdRef.current && snapshot.instanceId && snapshot.instanceId !== instanceIdRef.current) {
                logger.warn('DigitalTwinProvider', `CRITICAL: Backend Instance ID changed from ${instanceIdRef.current} to ${snapshot.instanceId}. Possible server restart or split-brain.`);
            }
            if (snapshot.instanceId) {
                instanceIdRef.current = snapshot.instanceId;
            }
            setData(snapshot);
            setLastUpdate(Date.now());
        };

        socket.on('twin:state', handleUpdate);

        return () => {
            socket.off('twin:state', handleUpdate);
        };
    }, [socket]);


    // Update browser tab title: serverName > hostname > IP
    useEffect(() => {
        if (!data) return;

        // Priority 1: Custom server name from settings
        if (data.serverName) {
            document.title = `${data.serverName} - ServiceBay`;
            return;
        }

        const firstNode = Object.values(data.nodes)[0];
        if (!firstNode?.resources) return;

        // Priority 2: Meaningful hostname
        const hostname = firstNode.resources.os?.hostname;
        if (hostname && hostname !== 'localhost' && !hostname.endsWith('.localdomain')) {
            document.title = `${hostname} - ServiceBay`;
            return;
        }

        // Priority 3: First public IPv4 address
        const network = firstNode.resources.network;
        if (network) {
            for (const addrs of Object.values(network)) {
                const publicAddr = addrs.find(a => a.family === 'IPv4' && !a.internal);
                if (publicAddr) {
                    document.title = `${publicAddr.address} - ServiceBay`;
                    return;
                }
            }
        }
    }, [data]);

    const isNodeSynced = (nodeName?: string) => {
        if (!data) return false;
        if (nodeName) {
            return data.nodes[nodeName]?.initialSyncComplete ?? false;
        }
        return Object.values(data.nodes).some(n => n.initialSyncComplete);
    };

    return (
        <DigitalTwinContext.Provider value={{ data, isConnected, lastUpdate, isNodeSynced }}>
            {children}
        </DigitalTwinContext.Provider>
    );
}

export function useDigitalTwinContext() {
    const context = useContext(DigitalTwinContext);
    if (!context) {
        throw new Error('useDigitalTwinContext must be used within a DigitalTwinProvider');
    }
    return context;
}
