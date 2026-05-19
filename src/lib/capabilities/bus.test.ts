/**
 * Capability bus contract tests (#629).
 *
 * Each test constructs a fresh bus via `createCapabilityBus()` rather
 * than touching the singleton — the singleton's job is process-wide
 * registration which we don't want to mutate from tests.
 *
 * Coverage:
 *   - subscribe / unsubscribe + list()
 *   - dispatch order matches registration order
 *   - one handler's failure (throw OR `{ ok: false }`) doesn't
 *     short-circuit sibling handlers
 *   - emit with zero subscribers returns `{ ok: true, results: [] }`
 *   - per-handler serial chain across emits (no interleaving)
 *   - throws are converted to `{ ok: false, retryable: true }` with the message
 *   - failures appear in both `results` and `failures`
 */
import { describe, it, expect, vi } from 'vitest';
import { createCapabilityBus } from './bus';
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

const MANIFEST: TemplateManifest = {
  label: 'Test',
  tier: 'feature',
  schemaVersion: 1,
  dependencies: [],
};
const VARS: StackVariable[] = [];

const INSTALLED = (template: string) => ({
  kind: 'feature.installed' as const,
  template,
  manifest: MANIFEST,
  variables: VARS,
});

describe('bus.subscribe / list / emit basics', () => {
  it('dispatches to every subscriber in registration order', async () => {
    const bus = createCapabilityBus();
    const calls: string[] = [];
    bus.subscribe('feature.installed', 'first', async () => { calls.push('first'); return { ok: true }; });
    bus.subscribe('feature.installed', 'second', async () => { calls.push('second'); return { ok: true }; });
    bus.subscribe('feature.installed', 'third', async () => { calls.push('third'); return { ok: true }; });

    const result = await bus.emit(INSTALLED('immich'));
    expect(result.ok).toBe(true);
    expect(result.results.map(r => r.handler)).toEqual(['first', 'second', 'third']);
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('returns ok with empty results when no subscribers exist', async () => {
    const bus = createCapabilityBus();
    const result = await bus.emit(INSTALLED('foo'));
    expect(result).toEqual({ ok: true, results: [], failures: [] });
  });

  it('list() returns handler names registered for a kind', () => {
    const bus = createCapabilityBus();
    bus.subscribe('feature.installed', 'a', async () => ({ ok: true }));
    bus.subscribe('feature.installed', 'b', async () => ({ ok: true }));
    bus.subscribe('feature.uninstalled', 'c', async () => ({ ok: true }));
    expect(bus.list('feature.installed')).toEqual(['a', 'b']);
    expect(bus.list('feature.uninstalled')).toEqual(['c']);
    expect(bus.list('feature.installing')).toEqual([]);
  });

  it('unsubscribe removes only the targeted handler', async () => {
    const bus = createCapabilityBus();
    const off = bus.subscribe('feature.installed', 'a', async () => ({ ok: true }));
    bus.subscribe('feature.installed', 'b', async () => ({ ok: true }));
    off();
    expect(bus.list('feature.installed')).toEqual(['b']);
  });
});

describe('error isolation', () => {
  it('one handler returning ok:false does not short-circuit others', async () => {
    const bus = createCapabilityBus();
    const calls: string[] = [];
    bus.subscribe('feature.installed', 'fails', async () => {
      calls.push('fails');
      return { ok: false, retryable: false, message: 'no' };
    });
    bus.subscribe('feature.installed', 'succeeds', async () => {
      calls.push('succeeds');
      return { ok: true };
    });

    const result = await bus.emit(INSTALLED('immich'));
    expect(result.ok).toBe(false);
    expect(calls).toEqual(['fails', 'succeeds']);
    expect(result.failures.map(r => r.handler)).toEqual(['fails']);
    expect(result.results).toHaveLength(2);
  });

  it('a handler that throws converts to retryable ok:false with the message', async () => {
    const bus = createCapabilityBus();
    bus.subscribe('feature.installed', 'thrower', async () => { throw new Error('boom'); });
    bus.subscribe('feature.installed', 'survivor', async () => ({ ok: true }));

    const result = await bus.emit(INSTALLED('immich'));
    expect(result.ok).toBe(false);
    const thrown = result.results[0].result;
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.retryable).toBe(true);
    expect(thrown.message).toBe('boom');
    // Sibling still ran.
    expect(result.results[1].result.ok).toBe(true);
  });

  it('a non-Error throw still gets a stringified message', async () => {
    const bus = createCapabilityBus();
    bus.subscribe('feature.installed', 'x', async () => { throw 'literal'; });
    const result = await bus.emit(INSTALLED('immich'));
    const r = result.results[0].result;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe('literal');
  });
});

describe('per-handler serial chain (no interleaving)', () => {
  it('back-to-back emits run a handler serially: A.start → A.end → B.start', async () => {
    const bus = createCapabilityBus();

    // We use a single deferred-resolve pattern so we can hold the first
    // invocation open until the second emit is in flight, then verify
    // the second invocation only ran AFTER the first one resolved.
    let firstResolve!: () => void;
    const firstHold = new Promise<void>(r => { firstResolve = r; });

    const eventsSeen: string[] = [];
    bus.subscribe('feature.installed', 'h', async (e) => {
      eventsSeen.push(`enter:${e.template}`);
      if (e.template === 'A') await firstHold;
      eventsSeen.push(`exit:${e.template}`);
      return { ok: true };
    });

    const emitA = bus.emit(INSTALLED('A'));
    const emitB = bus.emit(INSTALLED('B'));

    // Yield once so emitA's handler starts.
    await Promise.resolve();
    // emitB has been scheduled but the handler hasn't started yet — it's
    // queued behind A on the per-handler chain.
    expect(eventsSeen).toEqual(['enter:A']);

    firstResolve();
    await emitA;
    await emitB;

    // The second invocation only ran AFTER the first one exited.
    expect(eventsSeen).toEqual(['enter:A', 'exit:A', 'enter:B', 'exit:B']);
  });

  it('failures in one emit do not block the next emit for the same handler', async () => {
    const bus = createCapabilityBus();
    const handler = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'first fails' })
      .mockResolvedValueOnce({ ok: true });
    bus.subscribe('feature.installed', 'h', handler);

    const r1 = await bus.emit(INSTALLED('A'));
    const r2 = await bus.emit(INSTALLED('B'));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a thrown error in one emit does not break the chain for the next emit', async () => {
    const bus = createCapabilityBus();
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });
    bus.subscribe('feature.installed', 'h', handler);

    const r1 = await bus.emit(INSTALLED('A'));
    const r2 = await bus.emit(INSTALLED('B'));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
  });
});

describe('reset', () => {
  it('clears every registration', async () => {
    const bus = createCapabilityBus();
    bus.subscribe('feature.installed', 'a', async () => ({ ok: true }));
    bus.subscribe('feature.uninstalled', 'b', async () => ({ ok: true }));
    bus.reset();
    expect(bus.list('feature.installed')).toEqual([]);
    expect(bus.list('feature.uninstalled')).toEqual([]);
    const r = await bus.emit(INSTALLED('x'));
    expect(r.results).toEqual([]);
  });
});

describe('type-safety (compile-time)', () => {
  it('subscribe enforces handler signature matches the event kind', async () => {
    const bus = createCapabilityBus();
    const captured: Record<string, string> = {};
    // Each line below MUST compile — narrowing the event param on subscribe
    // is the contract that lets handlers skip the inner `if (e.kind === ...)`.
    bus.subscribe('feature.installed', 'a', async (e) => {
      // `e.manifest` only exists on the .installing / .installed shapes.
      captured.label = e.manifest.label;
      return { ok: true };
    });
    bus.subscribe('feature.uninstalled', 'b', async (e) => {
      // `e.template` is universal; the rest of the union is narrowed away.
      captured.template = e.template;
      return { ok: true };
    });
    bus.subscribe('feature.uninstalling', 'c', async (e) => {
      // `e.lastKnownVariables` only exists on the `.uninstalling` shape.
      captured.vars = String(e.lastKnownVariables.length);
      return { ok: true };
    });
    // @ts-expect-error — "not.a.real.event" isn't a valid CapabilityEventKind
    bus.subscribe('not.a.real.event', 'x', async () => ({ ok: true }));

    await bus.emit(INSTALLED('immich'));
    expect(captured.label).toBe('Test');
    await bus.emit({ kind: 'feature.uninstalled', template: 'foo' });
    expect(captured.template).toBe('foo');
    await bus.emit({ kind: 'feature.uninstalling', template: 'bar', lastKnownVariables: [] });
    expect(captured.vars).toBe('0');
  });
});
