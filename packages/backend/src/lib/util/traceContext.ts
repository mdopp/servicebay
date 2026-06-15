/**
 * Request-scoped trace context (#594).
 *
 * Generates a short slug per inbound request and propagates it across
 * every `await` in the same request via Node's `AsyncLocalStorage`.
 *
 * Server-only by usage — consumers (audit, executor, server entry)
 * all live in server-side code paths. NOT imported from the logger
 * itself: that would drag node:async_hooks into the client bundle
 * via webpack tracing, since `logger` is imported from client
 * dashboards. The trace ID surfaces through:
 *   - the MCP audit log (recordAudit auto-attaches it)
 *   - the agent's SSH command line (trailing `# SB_TRACE=…`)
 *   - the X-Trace-Id response header (UI error toasts paste it)
 *
 * `AsyncLocalStorage` is a no-op when no `runWithTrace` frame is
 * active, so `currentTraceId()` returns undefined for background
 * tasks (scheduled probes, agent listeners) — they continue to log
 * exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

interface TraceStore {
  traceId: string;
}

const als = new AsyncLocalStorage<TraceStore>();

/** Generate a short URL-safe trace ID. 8 hex chars is enough for
 *  grepping while still readable in log lines. */
export function newTraceId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/** Run `fn` inside a trace context with the given (or freshly
 *  generated) trace ID. Logs emitted from within `fn` and any awaits
 *  it spawns will carry the ID automatically. */
export function runWithTrace<T>(fn: () => T, traceId: string = newTraceId()): T {
  return als.run({ traceId }, fn);
}

/** Current trace ID, or undefined when called outside a tracked
 *  request (background jobs, scheduled probes, test fixtures). */
export function currentTraceId(): string | undefined {
  return als.getStore()?.traceId;
}
