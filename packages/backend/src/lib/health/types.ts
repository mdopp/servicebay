export type CheckType =
  | 'http'
  | 'ping'
  | 'script'
  | 'podman'
  | 'service'
  | 'systemd'
  | 'fritzbox'
  | 'node'
  | 'agent'
  | 'backup'
  | 'domain'
  | 'letsdebug'
  // Phase 3b (#484): four diagnose probes lifted into the health-check
  // subsystem. Each runs on its own schedule and persists results;
  // their diagnose-side modules became thin HealthStore readers.
  | 'lan_ip_drift'
  | 'npm_auth'
  | 'cert_expiry'
  | 'cert_request_failure'
  // DoH-based external view that replaces the continuous letsdebug
  // sweep. Cheap enough to run every 15 min (no third-party rate
  // limits — Cloudflare's 1.1.1.1 DoH absorbs household-grade traffic
  // without complaint). Surfaces "domain A record matches my known
  // public IP". For the full taxonomy (CAA, port-80 sim, etc.) the
  // operator triggers an on-demand letsdebug run from the diagnose
  // row's action button.
  | 'dns_routing';

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  target: string; // URL, IP, Container ID, or Script content
  interval: number; // in seconds
  enabled: boolean;
  created_at: string;
  nodeName?: string; // Optional node name for remote execution
  /**
   * Consecutive `fail` results required before this check is considered
   * "alerting" and emits a failure notification (#1651). A single flaky
   * poll (transient DNS, a one-tick timeout) shouldn't fire an alert —
   * we wait for N consecutive fails. Optional per-check override; when
   * unset, the per-type default ({@link DEFAULT_FAILURE_THRESHOLDS}) is
   * used. A value of 1 restores the legacy "alert on first fail" behaviour.
   */
  failureThreshold?: number;
  /**
   * A ServiceBay self-created check of a *known-local* hostNetwork service
   * (#1670) — e.g. the template-registered `home-assistant-api`
   * (`http://127.0.0.1:8123/`) or `ollama-api` (`http://127.0.0.1:11434/`)
   * probes a stack's post-deploy registers via the internal-token POST.
   * These legitimately target loopback, so the monitoring SSRF guard (which
   * exists to stop a *user-supplied* check from reaching internal hosts) must
   * not false-red them. Only the internal-token POST path stamps this true,
   * and the guard still requires the target itself to be a recognised
   * loopback service — a user-supplied internal URL never carries the flag
   * and stays blocked.
   */
  systemCheck?: boolean;
  // HTTP specific options
  httpConfig?: {
    expectedStatus?: number;
    bodyMatch?: string;
    bodyMatchType?: 'contains' | 'regex';
  };
  // FritzBox specific options
  fritzboxConfig?: {
    host?: string;
    user?: string;
    password?: string;
  };
  /**
   * Domain-reachability check options (auto-created by the apex/NPM
   * provisioner for every persisted proxy host). The target is the
   * domain itself (no scheme, no path); the runner resolves the
   * scheme from this config so an operator can later toggle ssl
   * expectations without recreating the check.
   *
   *   - expectedScheme: 'http' for `.home.arpa` / LAN-only routes,
   *     'https' for public-domain routes. Failing to match the
   *     scheme (e.g. https expected but only http reachable) is a
   *     `fail` result so the operator catches missing certs.
   *   - isPublic: surface the "Run external check" affordance in
   *     the UI; the on-demand endpoint hits letsdebug.net for an
   *     internet-side view of TLS + ACME readiness.
   *   - upstreamPort: optional target port — when the request
   *     succeeds with NPM's default "Congratulations" page we know
   *     the proxy route isn't actually wired to a backend, which
   *     reads identically to a happy 200 without this signal.
   */
  domainConfig?: {
    expectedScheme: 'http' | 'https';
    isPublic: boolean;
    upstreamPort?: number;
  };
}

/**
 * Typed shared probe result shape (#1539).
 *
 * The canonical structured payload a health probe attaches to its
 * persisted `CheckResult` so the on-demand diagnose reader gets a typed
 * struct instead of decoding a `JSON.stringify` blob out of the
 * free-text `message` field. Retires the per-probe `*_MESSAGE_PREFIX`
 * string bridge.
 *
 * `status` is the four-way diagnose status (`info` for "not applicable /
 * pending", distinct from the binary `CheckResult.status`). `items` are
 * per-row sub-findings (cert ids, ACME failures, …) the diagnose UI
 * renders with their own action buttons; `actionIds` on an item are the
 * probe-action ids that apply to that row. Declared structurally (no
 * import of the diagnose ProbeItem type) to avoid a health⇄diagnose
 * module cycle.
 */
export interface DiagnosticProbeItem {
  id: string;
  label: string;
  detail: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  actionIds?: string[];
}

export interface DiagnosticProbeResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: DiagnosticProbeItem[];
}

export interface CheckResult {
  check_id: string;
  timestamp: string;
  status: 'ok' | 'fail';
  latency?: number; // in ms
  message?: string;
  /**
   * Structured probe payload (#1539). Health probes whose diagnose
   * reader needs more than a status+message string attach the typed
   * struct here; the reader pulls it off directly. Persisted to disk
   * alongside the rest of the result. `unknown`-typed at the store
   * boundary so probe-specific shapes (dns_routing, letsdebug) ride the
   * same field — each consumer narrows it.
   */
  payload?: unknown;
  /**
   * True when this `fail` result actually emitted a failure alert (#1661).
   * Set by `runAndEmit` after the #1651 threshold AND the #1652 root-cause
   * gate both passed — i.e. an operator-visible "Check Failed" / causal-chain
   * email (or toast) went out for this tick. A downstream symptom suppressed
   * as a cascade leaf never gets the flag, so the recovery side can stay
   * symmetric: only a check that actually alerted on failure emits a
   * standalone "Service Recovered". Absent/false on `ok` results and on
   * suppressed fails.
   */
  alerted?: boolean;
}

/**
 * Self-repair payload a synthetic `diagnose:<probeId>` check carries on
 * its enriched row (#1423). Mirrors the frontend `DiagnoseProbe` shape so
 * the Checks tab can render the four-way status badge and open the
 * self-repair popup straight from the row, without re-running the suite.
 * Declared structurally here (no import) to avoid a health⇄diagnose cycle.
 */
export interface DiagnoseCheckPayload {
  status: 'ok' | 'warn' | 'fail' | 'info';
  label?: string;
  detail?: string;
  hint?: string;
  actions?: unknown[];
  items?: unknown[];
}

// Extended type for UI
export interface Check extends CheckConfig {
  status: 'ok' | 'fail' | 'unknown';
  lastRun: string | null;
  lastResult: string | null;
  message?: string;
  history: { status: 'ok' | 'fail'; latency: number; timestamp: string }[];
  /** Present only on synthetic diagnose rows (#1423). */
  diagnose?: DiagnoseCheckPayload;
}
