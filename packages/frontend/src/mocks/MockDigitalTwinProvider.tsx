'use client';

/**
 * Storybook / dev-mode wrapper that satisfies the same React context
 * `DigitalTwinProvider` populates at runtime, but skips the socket
 * connection and just exposes a static `DigitalTwinSnapshot`. Stories
 * for any component that calls `useDigitalTwin()` should wrap with
 * this (most often via a Storybook decorator).
 *
 * Default snapshot: `mockTwinSnapshot` (small fixture with three
 * services). Override via the `snapshot` prop for empty-state /
 * disconnected / loading variants.
 */

import { ReactNode } from 'react';
import { DigitalTwinContext, type DigitalTwinSnapshot } from '@/providers/DigitalTwinProvider';
import { mockTwinSnapshot } from './twin';

interface MockDigitalTwinProviderProps {
  children: ReactNode;
  snapshot?: DigitalTwinSnapshot | null;
  isConnected?: boolean;
}

export function MockDigitalTwinProvider({
  children,
  snapshot = mockTwinSnapshot,
  isConnected = true,
}: MockDigitalTwinProviderProps) {
  return (
    <DigitalTwinContext.Provider
      value={{
        data: snapshot,
        isConnected,
        // Frozen ts when the snapshot doesn't carry one — using
        // Date.now() here trips react-hooks/purity since stories
        // shouldn't see different values on every re-render.
        lastUpdate: snapshot?.nodes.Local?.lastSync ?? 0,
        isNodeSynced: (nodeName?: string) => {
          if (!snapshot) return false;
          const node = nodeName ? snapshot.nodes[nodeName] : Object.values(snapshot.nodes)[0];
          return Boolean(node?.initialSyncComplete);
        },
      }}
    >
      {children}
    </DigitalTwinContext.Provider>
  );
}
