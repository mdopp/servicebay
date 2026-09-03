/**
 * The runtime kernel's timer primitive (#2738).
 *
 * This module is the ONE place in `packages/backend/src` that may call
 * `setInterval`. Everything else asks for a {@link ManagedInterval}, which is
 * a timer with a name and an idempotent `stop()`.
 *
 * Why: before #2738 the backend had 13 bare `setInterval` calls spread over
 * seven modules and `server.ts`. None of them was cleared on SIGTERM, so a
 * restart could leave a tick mid-flight writing to a store the process was
 * already tearing down ("write after close"), and the only thing deciding what
 * started when was line position in an 800-line boot script.
 *
 * `scripts/invariants/backgroundTasks.ts` enforces the budget: bare
 * `setInterval` outside `lib/runtime/` is a build failure
 * (`BACKEND_BARE_SETINTERVAL_BUDGET`, 0).
 */
import { logger } from '@/lib/logger';

export interface ManagedInterval {
    /** Diagnostic name — shows up in the shutdown journal lines. */
    readonly name: string;
    /** Cancel the timer (and any pending first run). Idempotent. */
    stop(): void;
}

export interface ManagedIntervalOptions {
    /** Don't hold the event loop open for this timer. */
    unref?: boolean;
    /**
     * Run `tick` once this many ms after `managedInterval` is called, ahead of
     * the regular cadence. `0` runs it on the next macrotask. Omitted = the
     * first tick is one full interval away.
     */
    firstRunDelayMs?: number;
}

/**
 * A named, cancellable `setInterval`. The callback is wrapped so a throwing
 * tick logs instead of taking the process down — a background sweep must not
 * be able to kill the server.
 */
export function managedInterval(
    name: string,
    tick: () => void,
    intervalMs: number,
    options: ManagedIntervalOptions = {},
): ManagedInterval {
    const guarded = () => {
        try {
            tick();
        } catch (e) {
            logger.warn('Runtime', `Background tick "${name}" threw: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    let firstRun: ReturnType<typeof setTimeout> | null = null;
    if (options.firstRunDelayMs !== undefined) {
        firstRun = setTimeout(() => {
            firstRun = null;
            guarded();
        }, options.firstRunDelayMs);
        if (options.unref) firstRun.unref?.();
    }

    const timer = setInterval(guarded, intervalMs);
    if (options.unref) timer.unref?.();

    let stopped = false;
    return {
        name,
        stop() {
            if (stopped) return;
            stopped = true;
            if (firstRun) {
                clearTimeout(firstRun);
                firstRun = null;
            }
            clearInterval(timer);
        },
    };
}
