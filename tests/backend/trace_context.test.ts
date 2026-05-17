/**
 * Trace context unit tests (#594).
 *
 * Pure ALS behaviour — the HTTP wiring is exercised manually since
 * spinning a Next server inside vitest would be heavy.
 */

import { describe, it, expect } from 'vitest';
import { runWithTrace, currentTraceId, newTraceId } from '../../src/lib/util/traceContext';

describe('traceContext (#594)', () => {
  it('newTraceId() returns an 8-char hex string each call', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('currentTraceId() returns undefined outside a runWithTrace frame', () => {
    expect(currentTraceId()).toBeUndefined();
  });

  it('runWithTrace makes the id visible to currentTraceId synchronously', () => {
    runWithTrace(() => {
      expect(currentTraceId()).toBe('test-id-1');
    }, 'test-id-1');
  });

  it('the id survives across awaits inside the same frame', async () => {
    await runWithTrace(async () => {
      expect(currentTraceId()).toBe('async-id');
      await new Promise(r => setTimeout(r, 5));
      expect(currentTraceId()).toBe('async-id');
    }, 'async-id');
  });

  it('nested runWithTrace shadows the outer id (then restores)', () => {
    runWithTrace(() => {
      expect(currentTraceId()).toBe('outer');
      runWithTrace(() => {
        expect(currentTraceId()).toBe('inner');
      }, 'inner');
      expect(currentTraceId()).toBe('outer');
    }, 'outer');
  });

  it('a fresh id is generated when none supplied to runWithTrace', () => {
    let captured: string | undefined;
    runWithTrace(() => {
      captured = currentTraceId();
    });
    expect(captured).toMatch(/^[0-9a-f]{8}$/);
  });
});
