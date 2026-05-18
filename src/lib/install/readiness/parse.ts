/**
 * Readiness annotation parser (#613).
 *
 * Takes the raw YAML string of the `servicebay.readiness` annotation and
 * returns either a typed probe list or a list of human-readable errors.
 *
 * Two callers:
 *   - template/contract.ts at lint/test time, on the pre-Mustache YAML.
 *     `{{VAR}}` placeholders are preserved as-is, so the parser must
 *     accept strings that contain them (e.g. `port: {{LLDAP_PORT}}`
 *     parses fine as a YAML scalar).
 *   - install/runner.ts at deploy time, on the post-Mustache YAML, when
 *     all placeholders have been substituted to real values.
 *
 * Pure function — no fs / Node deps.
 */
import yaml from 'js-yaml';
import type { ReadinessProbe } from './types';

export type ParseReadinessResult =
  | { ok: true; probes: ReadinessProbe[] }
  | { ok: false; errors: string[] };

const DEFAULT_TIMEOUT_MS = 60_000;

const MUSTACHE_RE = /\{\{.*?\}\}/;
/** Sentinel that replaces `{{VAR}}` in permissive (pre-Mustache) mode.
 *  Chosen so it: (a) is a valid YAML scalar; (b) is structurally unique
 *  enough that no real probe value would ever match; (c) parses to a
 *  string by js-yaml so the permissive int/duration paths can spot it. */
const MUSTACHE_PLACEHOLDER = '__SB_MUSTACHE_PLACEHOLDER__';

/** Parse duration scalars like `60s`, `2m`, `500ms`. Bare numbers
 *  (or numeric strings without unit) default to seconds — that's how
 *  humans actually read `timeout: 30` in a YAML file. Returns `null`
 *  for unparseable values; the caller decides whether that's an error
 *  or, in permissive mode, an acceptable placeholder. */
function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Bare YAML number → seconds (ergonomic for authors).
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
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/** True if `v` is a string carrying the Mustache placeholder sentinel.
 *  In permissive (lint-time) mode the parser pre-replaces every
 *  `{{VAR}}` token with `MUSTACHE_PLACEHOLDER` so YAML parses cleanly;
 *  the type-checks then accept those fields as "to be filled in at
 *  install time". */
function isMustacheString(v: unknown): boolean {
  return typeof v === 'string' && (v.includes(MUSTACHE_PLACEHOLDER) || MUSTACHE_RE.test(v));
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Resolve the probe's timeout, falling back to the default if missing.
 *  An unparseable timeout (other than missing) is a config error. */
function resolveTimeout(entry: Record<string, unknown>, errors: string[], idx: number, permissive: boolean): number | null {
  const raw = entry.timeout;
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  const ms = parseDuration(raw);
  if (ms === null) {
    // Permissive (lint-time): accept `{{VAR}}` placeholders, the install
    // runner re-parses after Mustache substitution.
    if (permissive && isMustacheString(raw)) return DEFAULT_TIMEOUT_MS;
    errors.push(`probe[${idx}]: invalid \`timeout\` — expected duration like "60s", "2m", "500ms"; got ${JSON.stringify(raw)}`);
    return null;
  }
  return ms;
}

function normalizeProbe(entry: unknown, idx: number, errors: string[], permissive: boolean): ReadinessProbe | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`probe[${idx}]: expected an object with a \`kind\` field`);
    return null;
  }
  const obj = entry as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string') {
    errors.push(`probe[${idx}]: missing \`kind\` (one of \`http\`, \`tcp\`, \`ldap\`, \`command\`)`);
    return null;
  }
  const timeoutMs = resolveTimeout(obj, errors, idx, permissive);
  if (timeoutMs === null) return null;

  switch (kind) {
    case 'http': {
      const url = asString(obj.url);
      if (!url) { errors.push(`probe[${idx}] (http): missing \`url\``); return null; }
      const methodRaw = asString(obj.method);
      const method: 'GET' | 'POST' | undefined = methodRaw
        ? (methodRaw.toUpperCase() === 'POST' ? 'POST' : methodRaw.toUpperCase() === 'GET' ? 'GET' : (() => {
            errors.push(`probe[${idx}] (http): \`method\` must be \`GET\` or \`POST\`; got "${methodRaw}"`);
            return undefined;
          })())
        : undefined;
      const body = asString(obj.body) ?? undefined;
      let expectStatus: number | [number, number] | 'any' | undefined;
      const rawStatus = obj.expect_status ?? obj.expectStatus;
      if (rawStatus !== undefined && rawStatus !== null) {
        if (rawStatus === 'any') {
          expectStatus = 'any';
        } else if (Array.isArray(rawStatus) && rawStatus.length === 2) {
          const lo = asInt(rawStatus[0]); const hi = asInt(rawStatus[1]);
          if (lo === null || hi === null || lo > hi) {
            errors.push(`probe[${idx}] (http): \`expect_status\` range must be [lo, hi] with lo ≤ hi`);
          } else {
            expectStatus = [lo, hi];
          }
        } else {
          const n = asInt(rawStatus);
          if (n === null) {
            errors.push(`probe[${idx}] (http): \`expect_status\` must be an integer, [lo, hi], or "any"`);
          } else {
            expectStatus = n;
          }
        }
      }
      return { kind: 'http', url, method, body, expectStatus, timeoutMs };
    }
    case 'tcp': {
      const host = asString(obj.host);
      const port = asInt(obj.port) ?? (permissive && isMustacheString(obj.port) ? 0 : null);
      if (!host) { errors.push(`probe[${idx}] (tcp): missing \`host\``); return null; }
      if (port === null) { errors.push(`probe[${idx}] (tcp): missing or invalid \`port\``); return null; }
      return { kind: 'tcp', host, port, timeoutMs };
    }
    case 'ldap': {
      const host = asString(obj.host);
      const port = asInt(obj.port) ?? (permissive && isMustacheString(obj.port) ? 0 : null);
      if (!host) { errors.push(`probe[${idx}] (ldap): missing \`host\``); return null; }
      if (port === null) { errors.push(`probe[${idx}] (ldap): missing or invalid \`port\``); return null; }
      const bindDnRaw = obj.bind_dn ?? obj.bindDn;
      const bindPasswordRaw = obj.bind_password ?? obj.bindPassword;
      const bindDn = bindDnRaw === undefined ? undefined : asString(bindDnRaw) ?? undefined;
      const bindPassword = bindPasswordRaw === undefined ? undefined : asString(bindPasswordRaw) ?? undefined;
      if (bindDn && !bindPassword) {
        errors.push(`probe[${idx}] (ldap): \`bind_dn\` set without \`bind_password\` — declare both or neither`);
        return null;
      }
      return { kind: 'ldap', host, port, bindDn, bindPassword, timeoutMs };
    }
    case 'command': {
      const command = asString(obj.command);
      if (!command) { errors.push(`probe[${idx}] (command): missing \`command\``); return null; }
      const container = obj.container === undefined ? undefined : asString(obj.container) ?? undefined;
      const expectExit = obj.expect_exit ?? obj.expectExit;
      let exit: number | undefined;
      if (expectExit !== undefined && expectExit !== null) {
        const n = asInt(expectExit);
        if (n === null) {
          errors.push(`probe[${idx}] (command): \`expect_exit\` must be an integer`);
          return null;
        }
        exit = n;
      }
      return { kind: 'command', container, command, expectExit: exit, timeoutMs };
    }
    default:
      errors.push(`probe[${idx}]: unknown \`kind\` "${kind}" — must be one of \`http\`, \`tcp\`, \`ldap\`, \`command\``);
      return null;
  }
}

export interface ParseReadinessOptions {
  /** When true, accept `{{VAR}}` placeholders inside number/string fields
   *  (use at template-author / lint time, before Mustache substitution).
   *  The install runner calls without this flag — by then every value
   *  must be a concrete number/string. */
  permissive?: boolean;
}

/** Parse the readiness YAML body into typed probes. The body is the value
 *  of the `servicebay.readiness` annotation — typically a YAML block scalar
 *  containing a list of probe objects. */
export function parseReadinessYaml(body: string, opts: ParseReadinessOptions = {}): ParseReadinessResult {
  const permissive = opts.permissive === true;
  const errors: string[] = [];
  // In permissive mode, swap `{{VAR}}` for a quoted sentinel so js-yaml
  // doesn't try to parse `port: {{LLDAP_LDAP_PORT}}` as a nested flow
  // mapping. The downstream normalization recognizes the sentinel and
  // accepts those values as placeholders.
  const effective = permissive ? body.replace(/\{\{[^}]+\}\}/g, `"${MUSTACHE_PLACEHOLDER}"`) : body;
  let doc: unknown;
  try {
    doc = yaml.load(effective);
  } catch (e) {
    return { ok: false, errors: [`could not parse YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (doc === undefined || doc === null) {
    return { ok: false, errors: ['readiness body is empty — remove the annotation or add at least one probe'] };
  }
  if (!Array.isArray(doc)) {
    return { ok: false, errors: ['readiness body must be a YAML list of probe objects'] };
  }
  if (doc.length === 0) {
    return { ok: false, errors: ['readiness list is empty — remove the annotation or add at least one probe'] };
  }
  const probes: ReadinessProbe[] = [];
  for (let i = 0; i < doc.length; i++) {
    const probe = normalizeProbe(doc[i], i, errors, permissive);
    if (probe) probes.push(probe);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, probes };
}
