/**
 * `servicebay.healthcheck` annotation parser (#626 / Phase 3A).
 *
 * Each template ships a single block-scalar annotation describing how
 * to probe the service's readiness:
 *
 *   metadata:
 *     annotations:
 *       servicebay.healthcheck: |
 *         url: http://localhost:81/api/
 *         interval: 30s
 *         timeout: 5s
 *         startup_timeout: 5m
 *
 * For non-HTTP services (Samba), declare `kind: tcp` plus `host` + `port`
 * and ServiceBay does a TCP-connect probe, synthesising `{ ready: true }`
 * on connect. HTTP is the default and only requires `url`.
 *
 * The parsed config is consumed by `serviceHealth.ts` (the poller) and
 * is part of the contract returned by `parseTemplateManifest`. Pure
 * function — no fs / Node deps.
 *
 * Why not extend `install/readiness/parse.ts`: readiness probes are a
 * *list* of one-shot install-time checks (`http`, `tcp`, `ldap`,
 * `command`). The healthcheck annotation is a *single* continuous
 * probe definition with a different shape (interval, startup_timeout)
 * and a different lifecycle (continuous, not install-time-only). Phase
 * 3B will retire the readiness annotation once every template has a
 * healthcheck.
 */
import yaml from 'js-yaml';

export type HealthcheckKind = 'http' | 'tcp';
const KNOWN_KINDS: ReadonlySet<HealthcheckKind> = new Set(['http', 'tcp']);

/** Parsed config. Durations are normalised to milliseconds. */
export interface HealthcheckConfig {
  kind: HealthcheckKind;
  /** Required when `kind === 'http'`. Mustache placeholders inside the
   *  URL are passed through verbatim — the install runner resolves them
   *  at deploy time using the wizard's variable map; before then they
   *  stay opaque and the lint accepts the annotation. */
  url?: string;
  /** Required when `kind === 'tcp'`. */
  host?: string;
  port?: number;
  /** Poll cadence in milliseconds. Defaults to 30s. */
  intervalMs: number;
  /** Per-request timeout in milliseconds. Defaults to 5s. */
  timeoutMs: number;
  /**
   * How long after the service starts before a missed probe counts as
   * "unhealthy" (i.e. surfaces as `ready: false`). Cold-start grace.
   * Defaults to 5min. The poller starts firing immediately; this only
   * affects the *interpretation* of failures.
   */
  startupTimeoutMs: number;
}

export type ParseHealthcheckResult =
  | { ok: true; config: HealthcheckConfig }
  | { ok: false; errors: string[] };

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

const MUSTACHE_RE = /\{\{.*?\}\}/;

/**
 * Recognise a `{{VAR}}` placeholder that survived `yaml.load`.
 *
 * An unquoted block-scalar value like `port: {{VAR}}` is valid YAML flow
 * syntax: `{{VAR}: null}` — a single-key mapping whose key is itself the
 * mapping `{VAR: null}`. `js-yaml` stringifies that object key via
 * `String(key)`, yielding `{ '[object Object]': null }`. So a plain string
 * Mustache match never fires (the value is an object, not a string) and the
 * permissive bypass becomes dead code. Detect that signature here so an
 * unquoted `{{VAR}}` placeholder passes permissive validation the same as
 * the quoted `"{{VAR}}"` form. (#1688)
 */
function isMustachePlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return MUSTACHE_RE.test(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1 && keys[0] === '[object Object]';
  }
  return false;
}

/** Parse duration scalars like `60s`, `2m`, `500ms`. Bare numbers
 *  default to seconds (matches the readiness parser's ergonomic rule). */
function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? Math.round(value * 1000) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (MUSTACHE_RE.test(trimmed)) return null;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  const unit = m[2] ?? 's';
  if (!Number.isFinite(n) || n < 0) return null;
  return unit === 'ms' ? Math.round(n) : unit === 's' ? Math.round(n * 1000) : Math.round(n * 60_000);
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    return n > 0 ? n : null;
  }
  return null;
}

function validateIntervalDuration(obj: Record<string, unknown>, errors: string[]): number {
  let intervalMs = DEFAULT_INTERVAL_MS;
  if (obj.interval !== undefined && obj.interval !== null) {
    const ms = parseDuration(obj.interval);
    if (ms === null) {
      errors.push(`field \`interval\` must be a duration like "30s", "2m", "500ms"; got ${JSON.stringify(obj.interval)}`);
    } else if (ms < 1000) {
      errors.push(`field \`interval\` must be ≥ 1s to avoid spamming the service; got ${JSON.stringify(obj.interval)}`);
    } else {
      intervalMs = ms;
    }
  }
  return intervalMs;
}

function validateTimeoutDuration(obj: Record<string, unknown>, errors: string[]): number {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeout !== undefined && obj.timeout !== null) {
    const ms = parseDuration(obj.timeout);
    if (ms === null) errors.push(`field \`timeout\` must be a duration; got ${JSON.stringify(obj.timeout)}`);
    else timeoutMs = ms;
  }
  return timeoutMs;
}

function validateStartupTimeoutDuration(obj: Record<string, unknown>, errors: string[]): number {
  let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  if (obj.startup_timeout !== undefined && obj.startup_timeout !== null) {
    const ms = parseDuration(obj.startup_timeout);
    if (ms === null) errors.push(`field \`startup_timeout\` must be a duration; got ${JSON.stringify(obj.startup_timeout)}`);
    else startupTimeoutMs = ms;
  }
  return startupTimeoutMs;
}

function parseDurations(obj: Record<string, unknown>): { intervalMs: number; timeoutMs: number; startupTimeoutMs: number; errors: string[] } {
  const errors: string[] = [];
  const intervalMs = validateIntervalDuration(obj, errors);
  const timeoutMs = validateTimeoutDuration(obj, errors);
  const startupTimeoutMs = validateStartupTimeoutDuration(obj, errors);
  return { intervalMs, timeoutMs, startupTimeoutMs, errors };
}

function parseHttpHealthcheck(obj: Record<string, unknown>, errors: string[], permissive: boolean): string | undefined {
  const urlRaw = obj.url;
  if (urlRaw === undefined || urlRaw === null) {
    errors.push('field `url` is required for `kind: http`');
    return undefined;
  }
  if (typeof urlRaw !== 'string' || urlRaw.trim() === '') {
    // A bare unquoted `url: {{VAR}}` survives yaml.load as an object, not a
    // string — accept it permissively (resolved at runtime), like the tcp
    // port path. (#1688)
    if (permissive && isMustachePlaceholder(urlRaw)) return undefined;
    errors.push(`field \`url\` must be a non-empty string; got ${JSON.stringify(urlRaw)}`);
    return undefined;
  }
  const url = urlRaw.trim();
  const hasMustache = MUSTACHE_RE.test(url);
  if (!hasMustache || !permissive) {
    try {
      new URL(url);
    } catch {
      errors.push(`field \`url\` is not a valid URL: ${JSON.stringify(url)}`);
      return undefined;
    }
  }
  return url;
}

function parseTcpHealthcheck(obj: Record<string, unknown>, errors: string[], permissive: boolean): { host?: string; port?: number } {
  const result: { host?: string; port?: number } = {};
  const hostRaw = obj.host;
  if (hostRaw === undefined) {
    errors.push('field `host` is required for `kind: tcp`');
  } else if (typeof hostRaw !== 'string' || hostRaw.trim() === '') {
    errors.push(`field \`host\` must be a non-empty string; got ${JSON.stringify(hostRaw)}`);
  } else {
    result.host = hostRaw.trim();
  }
  const portRaw = obj.port;
  if (portRaw === undefined) {
    errors.push('field `port` is required for `kind: tcp`');
  } else {
    const p = asInt(portRaw);
    if (p === null) {
      if (!permissive || !isMustachePlaceholder(portRaw)) {
        errors.push(`field \`port\` must be a positive integer; got ${JSON.stringify(portRaw)}`);
      }
    } else {
      result.port = p;
    }
  }
  return result;
}

/**
 * Parse the raw block-scalar body of `servicebay.healthcheck`.
 *
 * `permissive` (default true): pre-Mustache-substitution YAML may carry
 * `{{VAR}}` placeholders inside `url` / `port` / `host`. We accept those
 * as opaque strings so the lint passes; the poller resolves them at
 * runtime via the deployed (post-render) annotation.
 */
export function parseHealthcheckYaml(
  rawYaml: string,
  options: { permissive?: boolean } = {},
): ParseHealthcheckResult {
  const permissive = options.permissive ?? true;
  const errors: string[] = [];

  let doc: unknown;
  try {
    doc = yaml.load(rawYaml);
  } catch (e) {
    return { ok: false, errors: [`invalid YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['expected a YAML mapping (url:/interval:/…)'] };
  }
  const obj = doc as Record<string, unknown>;

  const kindRaw = obj.kind;
  let kind: HealthcheckKind = 'http';
  if (kindRaw !== undefined) {
    if (typeof kindRaw !== 'string' || !KNOWN_KINDS.has(kindRaw as HealthcheckKind)) {
      errors.push(`field \`kind\` must be one of ${[...KNOWN_KINDS].map(v => `"${v}"`).join(', ')}; got ${JSON.stringify(kindRaw)}`);
    } else {
      kind = kindRaw as HealthcheckKind;
    }
  }

  let url: string | undefined;
  let host: string | undefined;
  let port: number | undefined;

  if (kind === 'http') {
    url = parseHttpHealthcheck(obj, errors, permissive);
  }

  if (kind === 'tcp') {
    const tcp = parseTcpHealthcheck(obj, errors, permissive);
    host = tcp.host;
    port = tcp.port;
  }

  const { intervalMs, timeoutMs, startupTimeoutMs, errors: durationErrors } = parseDurations(obj);
  errors.push(...durationErrors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { kind, url, host, port, intervalMs, timeoutMs, startupTimeoutMs } };
}
