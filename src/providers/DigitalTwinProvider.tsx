'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useSocket } from '@/hooks/useSocket';
import type { NodeTwin, GatewayState, ProxyState } from '@/lib/store/twin';

export interface DigitalTwinSnapshot {
  nodes: Record<string, NodeTwin>;
  gateway: GatewayState;
  proxy: ProxyState;
}

interface DigitalTwinContextType {
    data: DigitalTwinSnapshot | null;
    isConnected: boolean;
    lastUpdate: number;
    isNodeSynced: (nodeName?: string) => boolean;
}

const DigitalTwinContext = createContext<DigitalTwinContextType | undefined>(undefined);

export function DigitalTwinProvider({ children }: { children: ReactNode }) {
    const { socket, isConnected } = useSocket();
    const [data, setData] = useState<DigitalTwinSnapshot | null>(null);
    const [lastUpdate, setLastUpdate] = useState<number>(0);

    // Persist data across unmounts is automatic because this Provider is at root.

    useEffect(() => {
        if (!socket) return;

        const handleUpdate = (snapshot: DigitalTwinSnapshot) => {
            // Option: If we want to optimize, we can merge diffs here if the server sends diffs.
            // But currently it seems to send full snapshots or we just replace common parts.
            // The previous hook just did setData(snapshot).
            setData(snapshot);
            setLastUpdate(Date.now());
        };

        socket.on('twin:state', handleUpdate);

        return () => {
            socket.off('twin:state', handleUpdate);
        };
    }, [socket]);

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
