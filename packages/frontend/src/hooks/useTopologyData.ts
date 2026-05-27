'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import type { DigitalTwinSnapshot } from '@/providers/DigitalTwinProvider';
import type { NetworkGraph } from '@servicebay/api-client';

interface UseTopologyDataOptions {
  /** Called when a refresh kicks off — typically opens a toast. */
  onLoadStart?: () => void;
  /** Called when a refresh fails — typically resolves the toast as error. */
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
 *   2. Every digital-twin snapshot update triggers a debounced (500ms)
 *      re-fetch — the server pushes twin updates, not graph deltas, so
 *      polling on twin changes keeps the map in sync without a refresh
 *      button.
 *
 * The toast callbacks are intentionally pass-through: the hook itself
 * has no dependency on the toast provider so it stays testable.
 */
export function useTopologyData(options: UseTopologyDataOptions = {}): UseTopologyDataResult {
  const { onLoadStart, onLoadError } = options;
  const { data: twin } = useDigitalTwin();
  const [rawData, setRawData] = useState<NetworkGraph | null>(null);

  const fetchGraph = useCallback(async () => {
    onLoadStart?.();
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) {
        throw new Error('Failed to fetch network graph');
      }
      const data = await res.json();
      setRawData(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to reload network map';
      onLoadError?.(message);
    }
  }, [onLoadStart, onLoadError]);

  // Kick off the first render as soon as the dashboard mounts so the
  // toast shows immediately.
  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // Auto-fetch when Twin updates (debounced to avoid thrashing on
  // rapid SYNC_PARTIAL bursts during initial sync).
  useEffect(() => {
    if (!twin) return;
    const t = setTimeout(fetchGraph, 500);
    return () => { clearTimeout(t); };
  }, [twin, fetchGraph]);

  return { rawData, fetchGraph, twin };
}
