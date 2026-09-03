/**
 * Socket drain for the graceful shutdown (#2763).
 *
 * `server.close()` stops the listener and then waits for the open connections
 * to end **on their own**. On Node 22 that already drops the *idle* keep-alive
 * sockets, but it still waits forever on an **active** one — the MCP SSE
 * stream, a long-poll, a socket.io upgrade — and the backend always has some.
 * So every restart on the box ran out the 10 s budget and logged `forcing
 * exit` instead of `Shutdown complete`.
 *
 * The drain therefore closes the connections itself, in the order that lets
 * each step be a no-op for the next:
 *
 *   1. `io.close()` — socket.io disconnects its clients, so their transports
 *      stop counting as in-flight requests.
 *   2. `server.closeIdleConnections()` — anything sitting between requests
 *      dies now rather than after its keep-alive timeout.
 *   3. `server.close()` with a bounded grace: a connection still mid-request
 *      gets {@link DRAIN_GRACE_MS} to finish, then `closeAllConnections()`
 *      destroys it, and one more grace window later the drain resolves
 *      regardless. A stream must not be able to hold the process to the cap.
 *
 * The 10 s budget in `lifecycle.ts` stays the hard cap; this makes the normal
 * path resolve in milliseconds instead of hitting it.
 */
import { logger } from '@/lib/logger';

/** How long a mid-request connection gets before it is destroyed outright. */
export const DRAIN_GRACE_MS = 1_000;

/** The slice of `http.Server` the drain uses (Node >= 18.2 for the closers). */
interface DrainableHttpServer {
    close(cb?: (err?: Error) => void): unknown;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
}

/** The slice of a socket.io `Server` the drain uses. */
interface DrainableSocketServer {
    close(cb?: (err?: Error) => void): unknown;
}

export interface DrainOptions {
    server: DrainableHttpServer;
    /** Optional so a caller without socket.io (or a test) can drain just HTTP. */
    io?: DrainableSocketServer | null;
    graceMs?: number;
}

/**
 * Close socket.io, then the HTTP server, resolving once the listener is down —
 * always, and within `graceMs` of the last in-flight request.
 */
export async function drainSockets(options: DrainOptions): Promise<void> {
    const { server, io, graceMs = DRAIN_GRACE_MS } = options;

    if (io) {
        try {
            // Fire-and-forget: engine.io closes its clients synchronously, and
            // its callback waits on the same HTTP server we are about to close.
            io.close();
        } catch (e) {
            logger.warn('Runtime', `socket.io close failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    try {
        server.closeIdleConnections?.();
    } catch (e) {
        logger.warn('Runtime', `closeIdleConnections failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    await new Promise<void>(resolve => {
        let settled = false;
        let hard: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(grace);
            if (hard) clearTimeout(hard);
            resolve();
        };
        const grace = setTimeout(() => {
            logger.warn('Runtime', `HTTP connections still open after ${graceMs} ms, destroying them`);
            try {
                server.closeAllConnections?.();
            } catch (e) {
                logger.warn('Runtime', `closeAllConnections failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            // Last resort: the listener is down and every socket is destroyed,
            // so a `close` event that still does not arrive must not hold the
            // shutdown to the hard cap. This makes the drain total.
            hard = setTimeout(finish, graceMs);
            hard.unref?.();
        }, graceMs);
        grace.unref?.();
        // An already-closed server reports ERR_SERVER_NOT_RUNNING through the
        // same `close` event; that is still "the listener is down", so the
        // error argument is deliberately ignored.
        server.close(() => finish());
    });
}
