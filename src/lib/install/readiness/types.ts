/**
 * Declarative readiness probes — types (#613).
 *
 * A template's `servicebay.readiness` annotation declares one or more probes
 * the install runner waits on after the unit starts and before invoking
 * `post-deploy.py`. Probes replace the ad-hoc per-template wait helpers
 * (wait_for_lldap, wait_pod_running, wait_default_user, …) with a uniform
 * shape, the same retry budget, and the same operator-facing breadcrumb on
 * failure.
 *
 * Parsed shape (camelCase) — the YAML form is snake_case for ergonomic
 * authoring; the parser normalizes.
 */

export interface HttpProbe {
  kind: 'http';
  /** Full URL. Loopback / RFC1918 allowed (install host is always internal). */
  url: string;
  /** GET (default) or POST. */
  method?: 'GET' | 'POST';
  /** Optional request body for POST. Substituted after Mustache render. */
  body?: string;
  /** Single status (e.g. 200), `[lo, hi]` inclusive range, or `'any'` to
   *  accept any HTTP response (probe still asserts a response landed). */
  expectStatus?: number | [number, number] | 'any';
  /** Overall budget for this probe. */
  timeoutMs: number;
}

export interface TcpProbe {
  kind: 'tcp';
  host: string;
  port: number;
  timeoutMs: number;
}

export interface LdapProbe {
  kind: 'ldap';
  host: string;
  port: number;
  /** Optional simple-bind validation — without `bindDn` the probe is a
   *  plain TCP connect. */
  bindDn?: string;
  bindPassword?: string;
  timeoutMs: number;
}

export interface CommandProbe {
  kind: 'command';
  /** Container name inside the pod (e.g. `auth-lldap`). Required for pod-
   *  scoped exec; omit only when the command itself does the container
   *  selection (rare). */
  container?: string;
  /** Shell command line. Runs via the agent's `exec` action on the install
   *  target node (NOT inside the container directly — the command itself
   *  should `podman exec <ctr> …` when it needs to enter a container). */
  command: string;
  /** Expected exit code (default 0). */
  expectExit?: number;
  timeoutMs: number;
}

export type ReadinessProbe = HttpProbe | TcpProbe | LdapProbe | CommandProbe;

export type ProbeResult =
  | { ok: true; probe: ReadinessProbe; attempts: number; elapsedMs: number }
  | {
      ok: false;
      probe: ReadinessProbe;
      attempts: number;
      elapsedMs: number;
      /** Stable, machine-readable reason for the failure. */
      reason: 'timeout' | 'unexpected-response' | 'network-error' | 'config-error';
      /** Operator-facing message: short, actionable, no stack-trace noise. */
      message: string;
      /** Last response observed, if any (HTTP status, command exit code, etc.). */
      lastResponse?: string;
    };
