/**
 * Observed-flow store tests (#505) — the pure rolling-window logic:
 * `mergeFlows` (dedup + count) and `pruneRecords` (window expiry).
 */
import { describe, it, expect } from 'vitest';
import {
  mergeFlows,
  pruneRecords,
  WINDOW_MS,
  type ObservedEdgeRecord,
} from './flowsStore';

const T0 = Date.parse('2026-05-22T12:00:00.000Z');

describe('mergeFlows', () => {
  it('creates a record with count 1 for a never-seen flow', () => {
    const merged = mergeFlows([], [{ srcService: 'media', dstService: 'auth', dstPort: 9091 }], T0);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ srcService: 'media', dstService: 'auth', dstPort: 9091, count: 1 });
  });

  it('increments count + bumps lastSeen on a repeat sighting', () => {
    const first = mergeFlows([], [{ srcService: 'media', dstService: 'auth', dstPort: 9091 }], T0);
    const second = mergeFlows(first, [{ srcService: 'media', dstService: 'auth', dstPort: 9091 }], T0 + 60_000);
    expect(second).toHaveLength(1);
    expect(second[0].count).toBe(2);
    expect(second[0].lastSeen).toBe(new Date(T0 + 60_000).toISOString());
    expect(second[0].firstSeen).toBe(new Date(T0).toISOString());
  });

  it('counts a flow at most once per tick even if sampled twice', () => {
    const flow = { srcService: 'hermes', dstService: 'ollama', dstPort: 11434 };
    const merged = mergeFlows([], [flow, flow, flow], T0);
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(1);
  });

  it('prunes stale records as part of the merge', () => {
    const stale: ObservedEdgeRecord = {
      srcService: 'old', dstService: 'gone', dstPort: 1,
      firstSeen: new Date(T0 - 2 * WINDOW_MS).toISOString(),
      lastSeen: new Date(T0 - 2 * WINDOW_MS).toISOString(),
      count: 9,
    };
    const merged = mergeFlows([stale], [{ srcService: 'a', dstService: 'b', dstPort: 80 }], T0);
    expect(merged.map(r => r.srcService)).toEqual(['a']);
  });
});

describe('pruneRecords', () => {
  const rec = (lastSeenOffsetMs: number): ObservedEdgeRecord => ({
    srcService: 's', dstService: 'd', dstPort: 80,
    firstSeen: new Date(T0 + lastSeenOffsetMs).toISOString(),
    lastSeen: new Date(T0 + lastSeenOffsetMs).toISOString(),
    count: 1,
  });

  it('keeps records seen within the window', () => {
    expect(pruneRecords([rec(-WINDOW_MS + 1000)], T0)).toHaveLength(1);
  });

  it('drops records older than the window', () => {
    expect(pruneRecords([rec(-WINDOW_MS - 1000)], T0)).toHaveLength(0);
  });
});
