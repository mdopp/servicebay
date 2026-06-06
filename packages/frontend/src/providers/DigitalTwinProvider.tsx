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

// Intercept 401 responses from API calls and redirect to login.
// This handles session expiry gracefully instead of showing JSON parse errors.
//
// The pathname guard prevents an infinite reload loop on /login itself
// (#854) AND keeps the family portal from bouncing anonymous visitors
// to the admin login: /portal is intentionally anonymous-readable,
// but the root layout mounts this provider unconditionally — so a 401
// from any background fetch on /portal would silently relocate the
// visitor to /login a few hundred ms after landing. Kept in sync with
// the socket handler in useSocket.ts.
const ANONYMOUS_PATHS = new Set(['/login', '/portal']);
if (typeof window !== 'undefined') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        const pathname = window.location.pathname;
        const isAnonymousPage = ANONYMOUS_PATHS.has(pathname) || pathname.startsWith('/portal/');
        if (response.status === 401 && !isAnonymousPage) {
            const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : '';
            // Only redirect for our own API calls, not external fetches
            if (url.startsWith('/api/') || url.startsWith(window.location.origin + '/api/')) {
                window.location.href = '/login';
            }
        }
        return response;
    };
}

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
