/**
 * Capability-bus contract (#629 / Phase 4A).
 *
 * Platform services (Authelia, NPM, AdGuard, the credentials store)
 * subscribe to feature-lifecycle events and own the side effects that
 * used to live as hardcoded calls inside `install/runner.ts`:
 *   - register / unregister Authelia OIDC clients on install / uninstall
 *   - create / delete NPM proxy hosts
 *   - add / remove AdGuard DNS rewrites
 *   - persist credentials manifest entries
 *
 * The events here are intentionally narrow — four kinds, single shape
 * per kind. Adding a new event kind means adding to the discriminated
 * union below. The bus itself stays generic.
 *
 * Handlers don't see template internals — they read whatever they need
 * from `manifest` (annotations) and `variables` (resolved values from
 * the wizard). New feature templates declare their needs in
 * `variables.json` (`oidcClient`, `subdomain`, `proxyConfig`) and the
 * handlers pick those out — no template-specific branching.
 */
import type { TemplateManifest } from '@/lib/template/contract';
import type { StackVariable } from '@/lib/stackInstall/types';

/** Discriminated union of all bus events. The `kind` discriminator is
 *  the subscription key — `bus.subscribe('feature.installed', h)`
 *  only ever passes the `feature.installed` shape to `h`. */
export type CapabilityEvent =
  | FeatureInstallingEvent
  | FeatureInstalledEvent
  | FeatureUninstallingEvent
  | FeatureUninstalledEvent;

export type CapabilityEventKind = CapabilityEvent['kind'];

/**
 * Fired before any unit deploys. Handlers can veto with a non-retryable
 * error to abort the install. Use for pre-flight invariants (e.g. "this
 * stack needs a public domain and none is configured").
 */
export interface FeatureInstallingEvent {
  kind: 'feature.installing';
  template: string;
  manifest: TemplateManifest;
  variables: StackVariable[];
}

/**
 * Fired after the deployed unit has reached `health.ready === true`.
 * Handlers do the after-deploy provisioning (OIDC client registration,
 * proxy host creation, DNS rewrite, credentials persistence). Failures
 * here don't roll back the install — by design (one-shot installs,
 * no atomic-rollback in v1) — but they DO surface as diagnose findings
 * so the operator sees "Immich deployed but no OIDC client" rather
 * than a silent half-state.
 */
export interface FeatureInstalledEvent {
  kind: 'feature.installed';
  template: string;
  manifest: TemplateManifest;
  variables: StackVariable[];
}

/**
 * Fired before the unit is stopped during a wipe. Handlers get one
 * last chance to capture state the uninstall path can't reconstruct
 * (e.g. a credentials manifest entry to keep visible after wipe).
 *
 * `lastKnownVariables` is the snapshot from the most recent successful
 * install — handlers can't assume the live config still matches.
 */
export interface FeatureUninstallingEvent {
  kind: 'feature.uninstalling';
  template: string;
  lastKnownVariables: StackVariable[];
}

/**
 * Fired after the unit + data have been removed. Handlers clean up
 * cross-service state (OIDC client deletion, NPM proxy host removal,
 * DNS rewrite removal). A handler failure here is non-blocking but
 * gets surfaced as a diagnose finding.
 */
export interface FeatureUninstalledEvent {
  kind: 'feature.uninstalled';
  template: string;
}

/**
 * Handler return value. Failures are explicit so the bus can decide
 * whether to abort an install (non-retryable on `feature.installing`)
 * or surface a diagnose finding (everything else).
 *
 * Throwing from a handler is treated as `{ ok: false, retryable: true }`
 * with the error message — handlers shouldn't have to remember to wrap
 * everything in try/catch. The bus is the safety net.
 */
export type HandlerResult =
  | { ok: true }
  | { ok: false; retryable?: boolean; message: string };

/**
 * One handler subscribed to one event kind. Generic on `K` so the
 * `event` parameter is the exact shape for that kind — no need for
 * runtime `if (event.kind === ...)` discrimination inside handlers.
 */
export type CapabilityHandler<K extends CapabilityEventKind = CapabilityEventKind> = (
  event: Extract<CapabilityEvent, { kind: K }>,
) => Promise<HandlerResult>;

/**
 * Per-handler result, returned by `bus.emit` so the caller can decide
 * what to do with failures (abort install, log + continue, surface as
 * diagnose finding). The `handler` name is the registration label —
 * makes diagnose findings human-readable ("Authelia: still has OIDC
 * client for immich" instead of "handler #3").
 */
export interface HandlerInvocation {
  handler: string;
  result: HandlerResult;
}

export interface EmitResult {
  /** True iff every handler returned `{ ok: true }`. */
  ok: boolean;
  /** Per-handler results in registration order. */
  results: HandlerInvocation[];
  /** Convenience subset — only the failed invocations. */
  failures: HandlerInvocation[];
}
