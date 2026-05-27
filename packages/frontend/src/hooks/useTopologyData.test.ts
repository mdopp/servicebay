/**
 * useTopologyData — callback-stability tests (#1175).
 *
 * The NetworkDashboard route used to crash with React error #185 (max
 * update depth exceeded) because this hook accepted `onLoadStart` /
 * `onLoadError` as direct useCallback deps. Callers passing inline
 * arrows produced a fresh `fetchGraph` ref every render → the two
 * auto-fetch effects re-fired → each fetch's setRawData re-rendered →
 * fresh callbacks again → infinite loop.
 *
 * These tests pin the contract: fetchGraph keeps a stable identity
 * across renders, even when the option callbacks come from inline
 * arrows that change every time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// useTopologyData reads twin state via useDigitalTwin. Stub it so the
// hook doesn't try to wire up the real socket.io provider.
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: null }),
}));

import { useTopologyData } from './useTopologyData';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ nodes: [], edges: [] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTopologyData callback stability (#1175)', () => {
  it('returns a stable fetchGraph across renders even when callers pass fresh inline arrows', () => {
    const { result, rerender } = renderHook(() =>
      useTopologyData({
        onLoadStart: () => { /* fresh arrow every render */ },
        onLoadError: (msg) => { void msg; /* fresh arrow every render */ },
      }),
    );

    const firstFetchGraph = result.current.fetchGraph;
    rerender();
    rerender();
    rerender();
    expect(result.current.fetchGraph).toBe(firstFetchGraph);
  });

  it('still calls the LATEST onLoadStart / onLoadError when fetchGraph runs after a re-render', async () => {
    // Caller updates the callbacks every render. The hook must dispatch
    // to the most recent ones, not the originals captured at mount.
    let latestErr: string | null = null;
    let calls = 0;

    const { result, rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useTopologyData({
          onLoadStart: () => { calls += 1; },
          onLoadError: (msg) => { latestErr = `${tag}: ${msg}`; },
        }),
      { initialProps: { tag: 'first' } },
    );

    // Wait for the initial-mount fetch to complete
    await waitFor(() => expect(calls).toBeGreaterThan(0));

    // Re-render with a new tag — the callbacks change closure values.
    rerender({ tag: 'second' });

    // Force a failing fetch this time
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.fetchGraph();
    });
    expect(latestErr).toBe('second: boom');
  });
});
