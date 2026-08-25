import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// #2629 — the load state of the Operate list. The regression this locks down:
// the socket reports `isConnected` BEFORE the digital twin's first snapshot
// arrives, so "connected with an empty list" is ignorance, not absence. A hook
// that reports anything but `loading` in that window lets the per-service page
// render a definite "Service <name> was not found".

const twin = {
  current: {
    data: null as unknown,
    isConnected: false,
    lastUpdate: 0,
    isNodeSynced: () => false,
  },
};
vi.mock('@/hooks/useDigitalTwin', () => ({ useDigitalTwin: () => twin.current }));

const connection = { current: { status: 'reconnecting' as string } };
vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => connection.current,
}));

import { useOperateServices, useOperateService } from './useOperateServices';

function snapshot({ synced, services }: { synced: boolean; services: string[] }) {
  return {
    nodes: {
      Local: {
        connected: true,
        initialSyncComplete: synced,
        containers: [],
        files: {},
        services: services.map(name => ({
          name: `${name}.service`,
          active: true,
          activeState: 'active',
          subState: 'running',
          loadState: 'loaded',
          description: '',
          path: `/etc/containers/systemd/${name}.kube`,
          isManaged: true,
          associatedContainerIds: [],
          ports: [],
          verifiedDomains: [],
        })),
      },
    },
  };
}

/** Put the twin in the exact shape the hook sees for a given phase. */
function setTwin(opts: { connected: boolean; synced: boolean; services?: string[] }) {
  const data = opts.synced || opts.services?.length
    ? snapshot({ synced: opts.synced, services: opts.services ?? [] })
    : null;
  twin.current = {
    data,
    isConnected: opts.connected,
    lastUpdate: 0,
    isNodeSynced: () => opts.synced,
  };
}

beforeEach(() => {
  setTwin({ connected: false, synced: false });
  connection.current = { status: 'reconnecting' };
});

describe('useOperateServices load state (#2629)', () => {
  it('is loading before the socket connects', () => {
    const { result } = renderHook(() => useOperateServices());
    expect(result.current.state).toBe('loading');
    expect(result.current.services).toEqual([]);
  });

  it('is STILL loading once the socket is connected but the first twin snapshot has not landed', () => {
    // The exact regression window: connected, no snapshot. `isConnected` alone
    // must never be read as "the list is loaded and this service is absent".
    setTwin({ connected: true, synced: false });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateServices());
    expect(result.current.state).toBe('loading');
  });

  it('is ready once a node reports its initial sync complete', () => {
    setTwin({ connected: true, synced: true, services: ['immich'] });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateServices());
    expect(result.current.state).toBe('ready');
    expect(result.current.services.map(s => s.displayName)).toEqual(['immich']);
  });

  it('is ready on a snapshot that carries services even if the sync flag lags', () => {
    setTwin({ connected: true, synced: false, services: ['immich'] });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateServices());
    expect(result.current.state).toBe('ready');
  });

  it('reports unavailable — not an empty list — when the channel is offline and nothing ever arrived', () => {
    setTwin({ connected: false, synced: false });
    connection.current = { status: 'offline' };

    const { result } = renderHook(() => useOperateServices());
    expect(result.current.state).toBe('unavailable');
    expect(result.current.services).toEqual([]);
  });
});

describe('useOperateService — one service by routed name (#2629)', () => {
  it('reports loading, not a null verdict, while the snapshot is still on its way', () => {
    setTwin({ connected: true, synced: false });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateService('immich.service'));
    expect(result.current.state).toBe('loading');
    expect(result.current.service).toBeNull();
  });

  it('resolves the service once the snapshot is in hand', () => {
    setTwin({ connected: true, synced: true, services: ['immich'] });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateService('immich.service'));
    expect(result.current.state).toBe('ready');
    expect(result.current.service?.displayName).toBe('immich');
  });

  it('only reports a genuinely absent service against a synced snapshot', () => {
    setTwin({ connected: true, synced: true, services: ['immich'] });
    connection.current = { status: 'online' };

    const { result } = renderHook(() => useOperateService('nope'));
    expect(result.current.state).toBe('ready');
    expect(result.current.service).toBeNull();
  });
});
