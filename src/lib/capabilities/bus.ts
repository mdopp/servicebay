/**
 * Capability bus (#629 / Phase 4A).
 *
 * Typed in-process event dispatcher for the feature-lifecycle events
 * platform services subscribe to. The contract lives in `./types.ts`;
 * this file is the runtime.
 *
 * Why not Node's `EventEmitter`: EE is untyped, swallows handler
 * exceptions in a way that's hard to inspect from the emitter side,
 * and gives no per-handler ordering guarantee. The behaviour we need
 * is "for each subscriber, run their handler once for this event, and
 * collect every result" — which is closer to `Promise.all` over a
 * registration list than to fire-and-forget pub/sub.
 *
 * Key behaviours:
 *
 * - **Subscription is registration-ordered.** `bus.emit` runs handlers
 *   for an event in the order they subscribed. The `results` array
 *   matches that order so the caller can map findings back.
 *
 * - **One handler's failure does NOT short-circuit the rest.** A
 *   thrown exception or a `{ ok: false }` return surfaces in `results`
 *   and `failures`; sibling handlers still run. This matches the
 *   diagnose-finding model: every cross-service inconsistency should
 *   surface, not just the first one.
 *
 * - **Per-handler ordering across emits.** Each handler has its own
 *   serial promise chain. If `emit(A)` and `emit(B)` are dispatched
 *   back-to-back, handler H sees A complete before B starts. That's
 *   the property template authors rely on — e.g. Authelia's OIDC
 *   register/unregister can't interleave for the same template.
 *
 * - **Handlers are identified by a label.** Registration takes a
 *   `name` arg used in `HandlerInvocation.handler`. Failures surface
 *   as "Authelia: <message>" rather than "handler #3".
 *
 * The bus is a singleton at runtime (one process, one bus). Tests
 * construct fresh instances via `createCapabilityBus()` to avoid
 * polluting global state — keep both export paths.
 */
import { logger } from '@/lib/logger';
import type {
  CapabilityEvent,
  CapabilityEventKind,
  CapabilityHandler,
  EmitResult,
  HandlerInvocation,
  HandlerResult,
} from './types';

/** Erased once stored — the typed `subscribe` boundary already enforces
 *  that a handler only sees the event shape matching its kind. Internally
 *  we keep a single shape so the per-kind Map doesn't have to track the
 *  K param.
 *
 *  `handler: (event) => Promise<HandlerResult>` rather than
 *  `CapabilityHandler<K>` for that erasure — the call site at `runOne`
 *  always passes events of the matching kind, by construction. */
interface Registration {
  name: string;
  kind: CapabilityEventKind;
  handler: (event: CapabilityEvent) => Promise<HandlerResult>;
  /** Per-handler serial chain — see "Per-handler ordering" above. */
  chain: Promise<unknown>;
}

export interface CapabilityBus {
  /** Register a handler for one event kind. Returns an unsubscribe fn. */
  subscribe<K extends CapabilityEventKind>(
    kind: K,
    name: string,
    handler: CapabilityHandler<K>,
  ): () => void;

  /** Fire an event to every subscriber. Awaits every handler before
   *  resolving so the caller can react to failures synchronously. */
  emit(event: CapabilityEvent): Promise<EmitResult>;

  /** Diagnostic: handlers currently registered for `kind`. */
  list(kind: CapabilityEventKind): string[];

  /** Wipe every registration. Used by tests; never call in prod. */
  reset(): void;
}

export function createCapabilityBus(): CapabilityBus {
  // Per-kind registration lists. Erased to the unified Registration
  // shape once stored — the typed `subscribe` signature is the boundary
  // that keeps callers honest; internally the discriminator on
  // `Registration.kind` is the only thing that matters.
  const registrations = new Map<CapabilityEventKind, Registration[]>();

  const subscribe = <K extends CapabilityEventKind>(
    kind: K,
    name: string,
    handler: CapabilityHandler<K>,
  ): (() => void) => {
    const reg: Registration = {
      name,
      kind,
      // Widen at the boundary: subscribe's typed signature guarantees
      // the runtime never calls `handler` with the wrong event shape,
      // because `emit` only dispatches to handlers registered under the
      // matching kind.
      handler: handler as (event: CapabilityEvent) => Promise<HandlerResult>,
      chain: Promise.resolve(),
    };
    const list = registrations.get(kind) ?? [];
    list.push(reg);
    registrations.set(kind, list);
    return () => {
      const current = registrations.get(kind);
      if (!current) return;
      const idx = current.indexOf(reg);
      if (idx >= 0) current.splice(idx, 1);
    };
  };

  const emit = async (event: CapabilityEvent): Promise<EmitResult> => {
    const list = registrations.get(event.kind) ?? [];
    if (list.length === 0) {
      return { ok: true, results: [], failures: [] };
    }

    // Schedule each handler on its own serial chain so back-to-back
    // emits for the same handler don't interleave. We capture the
    // current chain tail per handler so the await waits for the slot
    // *this* emit will occupy, not whatever further calls might enqueue
    // before we reach `Promise.all`.
    const slotted = list.map((reg) => {
      const ran = reg.chain.then(() => runOne(reg, event));
      // Don't let a rejection break the chain — `runOne` already
      // converts throws into a `HandlerResult`; this guard is a
      // defence-in-depth so a future code change that throws OUTSIDE
      // `runOne` still keeps the queue alive.
      reg.chain = ran.catch(() => undefined);
      return ran.then((result) => ({ handler: reg.name, result }));
    });

    const results: HandlerInvocation[] = await Promise.all(slotted);
    const failures = results.filter(r => !r.result.ok);
    return {
      ok: failures.length === 0,
      results,
      failures,
    };
  };

  const list = (kind: CapabilityEventKind): string[] => {
    return (registrations.get(kind) ?? []).map(r => r.name);
  };

  const reset = (): void => {
    registrations.clear();
  };

  return { subscribe, emit, list, reset };
}

/** Per-handler invocation. Pulled out so the per-handler `chain` is the
 *  only seam between scheduling + the actual work — easier to reason
 *  about ordering.
 *
 *  Takes the erased `CapabilityHandler` shape because by the time a
 *  Registration is stored in the per-kind map, its `K` has widened to
 *  the full union — so the handler signature already accepts every
 *  event variant. The narrowing the call sites care about lives on
 *  `subscribe`, not here. */
async function runOne(
  reg: { name: string; handler: (event: CapabilityEvent) => Promise<HandlerResult> },
  event: CapabilityEvent,
): Promise<HandlerResult> {
  try {
    return await reg.handler(event);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('CapabilityBus', `handler "${reg.name}" threw on ${event.kind}: ${message}`);
    // Thrown errors are treated as retryable failures — the handler
    // didn't return a `{ ok: false, retryable: false }` decision, so
    // we shouldn't assume non-retryable on its behalf.
    return { ok: false, retryable: true, message };
  }
}

/**
 * Process-wide singleton. Handlers are registered once at boot via
 * `initCapabilities()` (see `init.ts`); the install runner uses this
 * to dispatch lifecycle events. Tests should NOT use the singleton —
 * they construct fresh buses via `createCapabilityBus()`.
 */
let _instance: CapabilityBus | null = null;
export function getCapabilityBus(): CapabilityBus {
  if (!_instance) _instance = createCapabilityBus();
  return _instance;
}
