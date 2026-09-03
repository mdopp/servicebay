/**
 * Runtime kernel — ordered start, REVERSE-order shutdown, and the force-exit
 * timer (#2738).
 *
 * The point of the kernel is the ordering guarantee, so that is what this
 * asserts, on fake timers: tasks stop in reverse registration order, THEN the
 * sockets drain, THEN the process exits. Before #2738 nothing stopped at all —
 * SIGTERM closed the sockets while 13 uncleared intervals were still ticking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  registerBackgroundTask,
  registerIntervalTask,
  startBackgroundTasks,
  stopBackgroundTasks,
  runGracefulShutdown,
  backgroundTaskNames,
  resetRuntimeForTests,
} from './lifecycle';

/** A task that appends `start:<name>` / `stop:<name>` to a shared trace. */
function tracer(trace: string[], name: string, opts: { failStop?: boolean; failStart?: boolean } = {}) {
  return {
    name,
    start: () => {
      trace.push(`start:${name}`);
      if (opts.failStart) throw new Error(`${name} start boom`);
    },
    stop: () => {
      trace.push(`stop:${name}`);
      if (opts.failStop) throw new Error(`${name} stop boom`);
    },
  };
}

beforeEach(() => {
  resetRuntimeForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetRuntimeForTests();
});

describe('background task registry', () => {
  it('starts tasks in registration order', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'a'));
    registerBackgroundTask(tracer(trace, 'b'));
    registerBackgroundTask(tracer(trace, 'c'));

    await startBackgroundTasks();

    expect(trace).toEqual(['start:a', 'start:b', 'start:c']);
    expect(backgroundTaskNames()).toEqual(['a', 'b', 'c']);
  });

  it('stops tasks in reverse registration order', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'a'));
    registerBackgroundTask(tracer(trace, 'b'));
    registerBackgroundTask(tracer(trace, 'c'));

    await startBackgroundTasks();
    trace.length = 0;
    await stopBackgroundTasks();

    expect(trace).toEqual(['stop:c', 'stop:b', 'stop:a']);
  });

  it('does not let a slow async start hold up the tasks behind it', async () => {
    const trace: string[] = [];
    registerBackgroundTask({
      name: 'slow',
      start: async () => {
        trace.push('start:slow');
        await new Promise<void>(resolve => setTimeout(resolve, 30_000));
        trace.push('ready:slow');
      },
      stop: () => { trace.push('stop:slow'); },
    });
    registerBackgroundTask(tracer(trace, 'fast'));

    const started = startBackgroundTasks();
    // `fast` is already running while `slow` is still awaiting its first
    // round-trip — the pre-#2738 boot script's fire-and-forget behaviour.
    expect(trace).toEqual(['start:slow', 'start:fast']);

    await vi.advanceTimersByTimeAsync(30_000);
    await started;
    expect(trace).toEqual(['start:slow', 'start:fast', 'ready:slow']);
  });

  it('starts a task registered after the runtime is already running', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'a'));
    await startBackgroundTasks();

    // This is `server.listen`'s late registrations (assist-catalog sync,
    // domain-check sync) — they must still land in the shutdown order.
    registerBackgroundTask(tracer(trace, 'late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(trace).toContain('start:late');

    trace.length = 0;
    await stopBackgroundTasks();
    expect(trace).toEqual(['stop:late', 'stop:a']);
  });

  it('never stops a task that failed to start, and keeps going past a failing stop', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'a'));
    registerBackgroundTask(tracer(trace, 'bad-start', { failStart: true }));
    registerBackgroundTask(tracer(trace, 'bad-stop', { failStop: true }));
    registerBackgroundTask(tracer(trace, 'd'));

    await startBackgroundTasks();
    trace.length = 0;
    await stopBackgroundTasks();

    // `bad-start` never started, so it is not stopped; `bad-stop` throwing
    // does not abort the rest of the sequence.
    expect(trace).toEqual(['stop:d', 'stop:bad-stop', 'stop:a']);
  });
});

describe('interval tasks', () => {
  it('ticks on the interval and stops ticking once stopped', async () => {
    const tick = vi.fn();
    registerIntervalTask({ name: 'ticker', intervalMs: 1_000, tick });
    await startBackgroundTasks();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(tick).toHaveBeenCalledTimes(3);

    await stopBackgroundTasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('honours firstRunDelayMs ahead of the cadence, and cancels a pending first run', async () => {
    const tick = vi.fn();
    registerIntervalTask({ name: 'delayed', intervalMs: 60_000, firstRunDelayMs: 500, tick });
    await startBackgroundTasks();

    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(1);

    await stopBackgroundTasks();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing tick', async () => {
    const tick = vi.fn(() => { throw new Error('boom'); });
    registerIntervalTask({ name: 'thrower', intervalMs: 100, tick });
    await startBackgroundTasks();

    await vi.advanceTimersByTimeAsync(300);
    expect(tick).toHaveBeenCalledTimes(3);
    await stopBackgroundTasks();
  });
});

describe('runGracefulShutdown', () => {
  it('stops tasks in reverse order, THEN drains sockets, THEN exits 0', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'terminal-sessions'));
    registerBackgroundTask(tracer(trace, 'health-service'));
    registerBackgroundTask(tracer(trace, 'gateway-poller'));
    registerBackgroundTask(tracer(trace, 'agent-health-sync'));
    await startBackgroundTasks();
    trace.length = 0;

    const exit = vi.fn();
    await runGracefulShutdown({
      signal: 'SIGTERM',
      drain: async () => { trace.push('drain:sockets'); },
      exit,
    });

    expect(trace).toEqual([
      'stop:agent-health-sync',
      'stop:gateway-poller',
      'stop:health-service',
      'stop:terminal-sessions',
      'drain:sockets',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is re-entrant-safe: a second signal does not run the sequence twice', async () => {
    const trace: string[] = [];
    registerBackgroundTask(tracer(trace, 'a'));
    await startBackgroundTasks();
    trace.length = 0;

    const exit = vi.fn();
    const drain = async () => { trace.push('drain'); };
    await runGracefulShutdown({ signal: 'SIGTERM', drain, exit });
    await runGracefulShutdown({ signal: 'SIGINT', drain, exit });

    expect(trace).toEqual(['stop:a', 'drain']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('force-exits 1 when the drain hangs past the timeout', async () => {
    const exit = vi.fn();
    void runGracefulShutdown({
      signal: 'SIGTERM',
      drain: () => new Promise<void>(() => { /* never resolves */ }),
      exit,
      timeoutMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the drain rejects', async () => {
    const exit = vi.fn();
    await runGracefulShutdown({
      signal: 'SIGTERM',
      drain: async () => { throw new Error('socket close failed'); },
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
