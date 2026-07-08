'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import type { DigitalTwinSnapshot } from '@/providers/DigitalTwinProvider';
import type { NetworkGraph } from '@servicebay/api-client';

interface UseTopologyDataOptions {
  /** Called when a refresh fails — typically surfaces an error toast. */
  onLoadError?: (message: string) => void;
}

interface UseTopologyDataResult {
  rawData: NetworkGraph | null;
  fetchGraph: () => Promise<void>;
  /** The latest twin snapshot — exposed so callers that need to read
   *  per-node twin state (e.g. for the node-detail drawer) don't have
   *  to re-call useDigitalTwin separately. */
  twin: DigitalTwinSnapshot | null;
}

/**
 * NetworkDashboard data layer (#1071 phase 1).
 *
 * Owns the graph-fetch primitive and the twin-driven auto-refresh
 * effects. UI concerns (toast plumbing, selection state, layout) stay
 * in NetworkDashboard.tsx; the hook only exposes the request callback
 * and the latest response.
 *
 * Auto-fetch behaviour:
 *   1. Initial mount triggers one fetch.
 *   2. Every digital-twin snapshot update triggers a debounced re-fetch
 *      — the server pushes twin updates, not graph deltas, so polling on
 *      twin changes keeps the map in sync without a refresh button.
 *      #2195 — twin updates fire on ANY status/metric/sync change (dozens
 *      per minute on a busy box), not just topology changes. The fetch is
 *      SILENT: it emits no loading toast, so a flurry of background twin
 *      updates never makes the UI restless. The dashboard shows a brief
 *      indicator only when the fetched topology actually changed (a full
 *      re-layout) — see NetworkDashboard.applyTopology. The debounce is
 *      raised to coalesce bursts of twin updates into at most one fetch.
 *
 * The error callback is intentionally pass-through: the hook itself has
 * no dependency on the toast provider so it stays testable.
 */
// #2195 — coalesce a burst of twin updates (status/metric flips) into a
// single re-fetch. Higher than the old 500ms so a flurry doesn't drive a
// fetch per update; still snappy enough to keep the map live.
const TWIN_REFETCH_DEBOUNCE_MS = 1000;

export function useTopologyData(options: UseTopologyDataOptions = {}): UseTopologyDataResult {
  const { data: twin } = useDigitalTwin();
  const [rawData, setRawData] = useState<NetworkGraph | null>(null);

  // #1175 — keep `onLoadStart` / `onLoadError` in refs so callers can
  // pass inline arrow functions without churning `fetchGraph`'s
  // identity. Without this, `useCallback([onLoadStart, onLoadError])`
  // saw a new ref every render, both effects below re-fired on every
  // render, and the NetworkDashboard hit React error #185 (max update
  // depth — fetch → setRawData → re-render → fresh callbacks → fresh
  // fetchGraph → effects re-fire → fetch …). The ref pattern keeps
  // the hook tolerant of unstable callers.
  const onLoadErrorRef = useRef(options.onLoadError);
  useEffect(() => {
    onLoadErrorRef.current = options.onLoadError;
  });

  const fetchGraph = useCallback(async () => {
    // #2195 — no onLoadStart / loading toast: the refresh is silent. The
    // dashboard decides whether to surface an indicator, and only does so
    // when the fetched topology actually changed (a re-layout), never for
    // a background status/metric merge.
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) {
        throw new Error('Failed to fetch network graph');
      }
      const data = await res.json();
      setRawData(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to reload network map';
      onLoadErrorRef.current?.(message);
    }
  }, []);

  // Kick off the first render as soon as the dashboard mounts so the
  // toast shows immediately.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async network-graph fetch on mount
    fetchGraph();
  }, [fetchGraph]);

  // Auto-fetch when Twin updates (debounced to avoid thrashing on
  // rapid SYNC_PARTIAL bursts during initial sync).
  useEffect(() => {
    if (!twin) return;
    const t = setTimeout(fetchGraph, TWIN_REFETCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); };
  }, [twin, fetchGraph]);

  return { rawData, fetchGraph, twin };
}
