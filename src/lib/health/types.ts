export type CheckType = 'http' | 'ping' | 'script' | 'podman' | 'service' | 'systemd' | 'fritzbox' | 'node' | 'agent' | 'backup' | 'domain' | 'letsdebug';

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  target: string; // URL, IP, Container ID, or Script content
  interval: number; // in seconds
  enabled: boolean;
  created_at: string;
  nodeName?: string; // Optional node name for remote execution
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

export interface CheckResult {
  check_id: string;
  timestamp: string;
  status: 'ok' | 'fail';
  latency?: number; // in ms
  message?: string;
}

// Extended type for UI
export interface Check extends CheckConfig {
  status: 'ok' | 'fail' | 'unknown';
  lastRun: string | null;
  lastResult: string | null;
  message?: string; 
  history: { status: 'ok' | 'fail'; latency: number; timestamp: string }[];
}
