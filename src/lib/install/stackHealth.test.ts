/**
 * Stack-health aggregation tests (#633).
 *
 * Tests the pure `aggregateStackHealth` over fixture maps — the
 * runtime `getStackHealth` (which reads the twin singleton + registry)
 * is tested at integration scope.
 */
import { describe, it, expect } from 'vitest';
import { aggregateStackHealth } from './stackHealth';

describe('aggregateStackHealth', () => {
  it('returns ready=true when every child is ready', () => {
    const r = aggregateStackHealth(['nginx', 'auth'], new Map([
      ['nginx', { ready: true }],
      ['auth', { ready: true }],
    ]));
    expect(r.ready).toBe(true);
    expect(r.children).toEqual({ nginx: 'ready', auth: 'ready' });
    expect(r.hasAnySignal).toBe(true);
  });

  it('returns ready=false when any child is unhealthy', () => {
    const r = aggregateStackHealth(['nginx', 'auth'], new Map([
      ['nginx', { ready: true }],
      ['auth', { ready: false }],
    ]));
    expect(r.ready).toBe(false);
    expect(r.children).toEqual({ nginx: 'ready', auth: 'unhealthy' });
  });

  it('marks children with no health signal as unknown', () => {
    const r = aggregateStackHealth(['nginx', 'auth'], new Map([
      ['nginx', { ready: true }],
      // auth missing entirely
    ]));
    expect(r.ready).toBe(false);
    expect(r.children.auth).toBe('unknown');
  });

  it('all-unknown stacks report hasAnySignal=false', () => {
    const r = aggregateStackHealth(['a', 'b'], new Map());
    expect(r.ready).toBe(false);
    expect(r.hasAnySignal).toBe(false);
  });

  it('degraded propagates from any child', () => {
    const r = aggregateStackHealth(['a'], new Map([
      ['a', { ready: true, degraded: true }],
    ]));
    expect(r.ready).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('empty stack reports ready=false (nothing to aggregate)', () => {
    const r = aggregateStackHealth([], new Map());
    expect(r.ready).toBe(false);
    expect(r.children).toEqual({});
  });
});
