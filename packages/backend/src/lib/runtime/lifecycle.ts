/**
 * Background-task registry + ordered shutdown (#2738).
 *
 * Every recurring backend job is a {@link BackgroundTask}: a `name`, a `start`
 * and a `stop`. `server.ts` holds the LIST — it no longer holds timers — and
 * the kernel decides what that list means:
 *
 *   - `startBackgroundTasks()` starts everything registered so far, in
 *     registration order. A task registered afterwards starts immediately, so
 *     a subsystem that only becomes available later (inside `server.listen`,
 *     say) still lands in the same registry.
 *   - `runGracefulShutdown()` on SIGTERM/SIGINT stops the tasks in REVERSE
 *     registration order, then drains the sockets, then exits. Reverse order is
 *     what makes teardown the mirror of boot: a task can rely on everything
 *     registered before it still being alive while it stops.
 *
 * Each stop is logged, so `journalctl --user -u servicebay` after a restart
 * shows the teardown as an ordered sequence instead of nothing at all.
 *
 * Failures are contained: a task that throws on start or stop is logged and the
 * rest of the sequence continues. A shutdown must not be able to wedge on one
 * bad subsystem — that is what the force-exit timer below is for.
 */
import { logger } from '@/lib/logger';
import { managedInterval, type ManagedInterval } from './timers';

export interface BackgroundTask {
    /** Stable, log-friendly identity (`gateway-poller`, `trash-purge`, …). */
    readonly name: string;
    start(): void | Promise<void>;
    stop(): void | Promise<void>;
}

interface Entry {
    task: BackgroundTask;
    started: boolean;
}

/** Registration order IS shutdown order, reversed. */
const registry: Entry[] = [];
let runtimeStarted = false;
let shuttingDown = false;

/** How long the whole shutdown gets before we stop being graceful. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

async function startEntry(entry: Entry): Promise<void> {
    if (entry.started) return;
    entry.started = true;
    try {
        await entry.task.start();
    } catch (e) {
        entry.started = false;
        logger.error('Runtime', `Background task "${entry.task.name}" failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Add a task to the registry. Returns the task so a module can register and
 * keep a handle in one expression. If the runtime is already started (a task
 * registered late, e.g. from the `server.listen` callback) it is started now.
 */
export function registerBackgroundTask(task: BackgroundTask): BackgroundTask {
    const entry: Entry = { task, started: false };
    registry.push(entry);
    if (runtimeStarted) void startEntry(entry);
    return task;
}

export interface IntervalTaskSpec {
    name: string;
    intervalMs: number;
    tick: () => void | Promise<void>;
    /** Ahead-of-cadence first run, matching the old `setTimeout` + `setInterval` pairs. */
    firstRunDelayMs?: number;
    unref?: boolean;
}

/** The common shape: "run this every N ms". */
export function intervalBackgroundTask(spec: IntervalTaskSpec): BackgroundTask {
    let handle: ManagedInterval | null = null;
    return {
        name: spec.name,
        start() {
            if (handle) return;
            handle = managedInterval(spec.name, () => { void spec.tick(); }, spec.intervalMs, {
                firstRunDelayMs: spec.firstRunDelayMs,
                unref: spec.unref,
            });
        },
        stop() {
            handle?.stop();
            handle = null;
        },
    };
}

/** Sugar for the overwhelmingly common `registerBackgroundTask(intervalBackgroundTask(…))`. */
export function registerIntervalTask(spec: IntervalTaskSpec): BackgroundTask {
    return registerBackgroundTask(intervalBackgroundTask(spec));
}

/** Registered task names, in registration order. */
export function backgroundTaskNames(): string[] {
    return registry.map(e => e.task.name);
}

/**
 * Start every registered task. Each `start()` is INVOKED in registration order,
 * synchronously — but a slow async start (the gateway poller's first FritzBox
 * round-trip, say) does not hold up the ones behind it, which is the
 * fire-and-forget behaviour the pre-#2738 boot script had. The returned promise
 * settles once every start has.
 */
export async function startBackgroundTasks(): Promise<void> {
    runtimeStarted = true;
    const pending = [...registry].map(entry => startEntry(entry));
    logger.info('Runtime', `Background tasks started (${registry.length}): ${backgroundTaskNames().join(', ')}`);
    await Promise.all(pending);
}

/**
 * Stop every started task in REVERSE registration order. Each stop is awaited
 * and logged; a throwing stop is logged and does not abort the sequence.
 */
export async function stopBackgroundTasks(): Promise<void> {
    runtimeStarted = false;
    for (const entry of [...registry].reverse()) {
        if (!entry.started) continue;
        entry.started = false;
        try {
            await entry.task.stop();
            logger.info('Runtime', `Stopped background task "${entry.task.name}"`);
        } catch (e) {
            logger.warn('Runtime', `Background task "${entry.task.name}" failed to stop: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export interface GracefulShutdownOptions {
    /** The signal that triggered this, for the log line. */
    signal: string;
    /** Close sockets/listeners. Runs AFTER every background task has stopped. */
    drain: () => Promise<void>;
    /** Injected so the ordering is testable without killing the test runner. */
    exit: (code: number) => void;
    timeoutMs?: number;
}

/**
 * Tasks (reverse order) → sockets → exit. Re-entrant calls are ignored, so a
 * SIGINT arriving during a SIGTERM shutdown doesn't run the sequence twice.
 */
export async function runGracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Runtime', `Received ${options.signal}, starting graceful shutdown`);

    const force = setTimeout(() => {
        logger.error('Runtime', 'Graceful shutdown timeout, forcing exit');
        options.exit(1);
    }, options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    force.unref?.();

    try {
        await stopBackgroundTasks();
        await options.drain();
        clearTimeout(force);
        logger.info('Runtime', 'Shutdown complete');
        options.exit(0);
    } catch (e) {
        clearTimeout(force);
        logger.error('Runtime', 'Error during shutdown', e);
        options.exit(1);
    }
}

/** Test-only: drop the registry and the shutdown latch without stopping anything. */
export function resetRuntimeForTests(): void {
    registry.length = 0;
    runtimeStarted = false;
    shuttingDown = false;
}
