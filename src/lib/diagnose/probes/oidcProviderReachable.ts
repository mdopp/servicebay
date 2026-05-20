/**
 * `oidc_provider_reachable` probe (#623, #736) — surfaces the case where
 * Authelia's container is "up" but its OIDC discovery endpoint
 * doesn't answer with a parseable 200, and classifies the underlying
 * cause so the diagnose card can offer one structured action instead
 * of a paragraph of "could be one of these three things".
 *
 * Why a dedicated probe: the Authelia outage in #622 had
 * `crash_loop` saying "all stable" (RestartCount blind spot,
 * fixed separately) and `domain_external_reachability` saying
 * "DNS routing OK" — neither noticed that `/.well-known/openid-
 * configuration` was returning 502 because Authelia's storage
 * encryption key had drifted from its preserved DB. Every
 * SSO-gated service was returning 502 to the user. This probe
 * fires within one diagnose-cycle in that scenario.
 *
 * Structured-actions refactor (#736): when fetch returns non-200
 * or the connection refuses, the probe pulls `podman logs --tail
 * 50 auth-authelia` and pattern-matches the output into one of:
 *   - `config`  — Authelia's YAML / env failed validation.
 *   - `ldap`    — LLDAP bind failing (Invalid Credentials / no
 *                 connection).
 *   - `storage` — encryption key drift from a reinstall —
 *                 db.sqlite3 + lldap users.db are encrypted with
 *                 the previous deployment's key.
 *   - `unknown` — fetch broke but logs don't match a known pattern.
 * The detail line names the specific cause; `show_recent_logs` +
 * `restart_authelia` actions (registered below) are available on
 * every fail/warn state. Destructive recovery (wiping storage) is
 * deliberately not surfaced as a one-click — the operator should
 * follow the Reset wizard if encryption-key drift is confirmed.
 *
 * Skip cases:
 *   - No `auth` template installed → nothing to probe (info).
 *   - No `publicDomain` configured → can't build the URL (info).
 *
 * The actual fetch goes against the **internal** Authelia port,
 * not the public DNS name. That's deliberate: if NPM is also
 * down we want this probe to still fire (a public-URL check
 * would confuse "Authelia broken" with "NPM broken" — separate
 * problems with separate fixes). The endpoint shape and parsed
 * JSON are the same either way.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'oidc_provider_reachable';

export type OidcFailCategory = 'config' | 'ldap' | 'storage' | 'unknown';

export interface OidcProviderResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  category?: OidcFailCategory;
}

// Authelia's default port inside the auth pod. Hard-coded here to keep
// the probe free of template-discovery overhead — if a future install
// rebinds Authelia to a different port the value lives in env
// (AUTHELIA_PORT), so honour that first.
const AUTHELIA_DEFAULT_PORT = 9091;
const DISCOVERY_TIMEOUT_MS = 4000;
const LOG_FETCH_TIMEOUT_MS = 5000;
const AUTHELIA_CONTAINER = 'auth-authelia';

function buildDiscoveryUrl(): string {
  const port = parseInt(process.env.AUTHELIA_PORT || '', 10);
  const effective = Number.isFinite(port) && port > 0 ? port : AUTHELIA_DEFAULT_PORT;
  return `http://127.0.0.1:${effective}/.well-known/openid-configuration`;
}

/** Pattern-match Authelia log tail into a category. The first match
 *  wins; storage/config patterns are checked before LDAP because LDAP
 *  errors often appear as side-effects of a broken config (the bind
 *  string never gets evaluated). */
export function classifyAutheliaLogs(logs: string): {
  category: OidcFailCategory;
  summary: string;
} {
  const trimmed = logs.trim();
  if (!trimmed) {
    return { category: 'unknown', summary: 'Authelia logs were empty' };
  }
  // Storage / encryption key drift — single most painful failure
  // mode (preserved DB + new install = decrypt failure on every
  // boot). Authelia logs this as a fatal-level error referencing
  // the storage driver and cipher.
  if (/(unable to decrypt|encryption.+(?:invalid|mismatch|drift)|storage.*(?:decrypt|cipher)|cipher.*storage|encryption key (?:has )?(?:changed|been altered)|encryption_key)/i.test(trimmed)) {
    return {
      category: 'storage',
      summary: 'storage encryption key drift (DB cannot be decrypted with the current config key)',
    };
  }
  // Authelia explicitly logs "Configuration:" / "configuration is invalid"
  // when YAML fails to parse or required fields are missing.
  if (/(configuration[:\s].*(?:invalid|error|cannot|failed)|panic:|fatal.*configuration|YAML)/i.test(trimmed)) {
    return {
      category: 'config',
      summary: 'Authelia configuration failed validation',
    };
  }
  // LDAP bind against LLDAP — surfaces as "Invalid Credentials" or
  // "LDAP Result Code 49" or connection errors against the lldap
  // host. Check after config/storage because those broader failures
  // can spuriously emit LDAP errors as a side effect.
  if (/(invalid credentials|ldap result code 49|ldap.*(?:bind|connect).*(?:fail|refused)|lldap.*refused)/i.test(trimmed)) {
    return {
      category: 'ldap',
      summary: 'LDAP bind to LLDAP is failing',
    };
  }
  return {
    category: 'unknown',
    summary: 'Authelia is unhealthy but the log tail does not match a known pattern',
  };
}

const HINT_BY_CATEGORY: Record<OidcFailCategory, string> = {
  config:
    'Click "Show recent logs" for the offending lines, then edit /opt/servicebay/services/auth/authelia/configuration.yml and restart auth.service. Common causes: malformed YAML after a manual edit or a missing required field after a version bump.',
  ldap:
    'Click "Show recent logs" to confirm the bind message. Most common cause is a reinstall that kept LLDAP\'s users.db but reset the password file — easiest recovery is the Reset wizard from Settings → Install (it re-seeds LLDAP and re-derives the bind password).',
  storage:
    'Authelia\'s db.sqlite3 was encrypted with a previous install\'s storage key. Use the Reset wizard from Settings → Install to wipe authelia-data/ + lldap users.db and re-seed — restarting auth.service alone will not recover.',
  unknown:
    'Click "Show recent logs" to inspect the failure mode, then "Restart auth" once the underlying cause is corrected.',
};

async function fetchAutheliaLogs(nodeName: string): Promise<string | null> {
  try {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand(
      'exec',
      { command: `podman logs --tail 50 ${AUTHELIA_CONTAINER} 2>&1` },
      { timeoutMs: LOG_FETCH_TIMEOUT_MS },
    ) as { code?: number; stdout?: string };
    const out = (res.stdout ?? '').trim();
    return out || null;
  } catch (e) {
    logger.info(`diagnose:${PROBE_ID}`, `log fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function checkOidcProviderReachable(nodeName: string = 'Local'): Promise<OidcProviderResult> {
  const cfg = await getConfig();
  const installed = cfg.installedTemplates?.auth;
  if (!installed) {
    return {
      status: 'info',
      detail: 'Auth template not installed — no OIDC provider to probe.',
    };
  }
  if (!cfg.reverseProxy?.publicDomain) {
    return {
      status: 'info',
      detail: 'publicDomain not yet configured — skip until the wizard finishes.',
    };
  }

  const url = buildDiscoveryUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const logs = await fetchAutheliaLogs(nodeName);
    const { category, summary } = logs
      ? classifyAutheliaLogs(logs)
      : { category: 'unknown' as OidcFailCategory, summary: 'no log output' };
    return {
      status: 'fail',
      detail: `Authelia OIDC discovery (${url}) did not respond: ${reason}. Cause: ${summary}.`,
      hint: HINT_BY_CATEGORY[category],
      category,
    };
  }

  if (response.status !== 200) {
    const logs = await fetchAutheliaLogs(nodeName);
    const { category, summary } = logs
      ? classifyAutheliaLogs(logs)
      : { category: 'unknown' as OidcFailCategory, summary: 'no log output' };
    return {
      status: 'fail',
      detail: `Authelia OIDC discovery returned HTTP ${response.status} (expected 200) — every SSO-gated service will be returning 502 to users right now. Cause: ${summary}.`,
      hint: HINT_BY_CATEGORY[category],
      category,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: 'fail',
      detail: 'Authelia OIDC discovery answered 200 but the body was not valid JSON.',
      hint: 'Likely a reverse-proxy mismatch (NPM returned an error page with a 200 status code). Test with `curl -v http://127.0.0.1:9091/.well-known/openid-configuration` on the host.',
      category: 'unknown',
    };
  }

  // Lightweight schema check: the discovery doc must declare the four
  // endpoints relying-party libraries actually consume. If any of them
  // are missing, OIDC clients (Immich, HA, ABS) will fail with "Failed
  // to discover OpenID provider" even though the 200 looked fine.
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'];
  const missing = required.filter(k => !(body && typeof body === 'object' && k in (body as Record<string, unknown>)));
  if (missing.length > 0) {
    return {
      status: 'warn',
      detail: `Authelia OIDC discovery answered 200 but is missing: ${missing.join(', ')}.`,
      hint: 'Likely an Authelia config that disabled some endpoints, or an in-progress upgrade. Click "Show recent logs" for context, then "Restart auth" once the config is corrected.',
      category: 'config',
    };
  }

  return {
    status: 'ok',
    detail: `Authelia OIDC discovery answers 200 with a valid configuration document.`,
  };
}

// ---------------------------------------------------------------------------
// Actions: structured remediations the diagnose card hangs off the probe row.
// Both are read/restart-only — destructive recovery (storage wipe) is left to
// the Reset wizard so the operator gets confirm-screen guards around it.
// ---------------------------------------------------------------------------

async function showRecentLogs({ node }: { node: string }): Promise<ProbeActionResult> {
  const logs = await fetchAutheliaLogs(node);
  if (!logs) {
    return {
      ok: true,
      message: 'No log output from auth-authelia (container may be down — try "Restart auth" first).',
      refresh: false,
    };
  }
  const { summary } = classifyAutheliaLogs(logs);
  return {
    ok: true,
    message: `Pulled ${logs.split('\n').length} lines from auth-authelia — ${summary}.`,
    details: logs,
    refresh: false,
  };
}

async function restartAuthelia({ node }: { node: string }): Promise<ProbeActionResult> {
  try {
    const agent = await agentManager.ensureAgent(node);
    const res = await agent.sendCommand(
      'exec',
      { command: 'systemctl --user restart auth.service 2>&1' },
      { timeoutMs: 30_000 },
    ) as { code?: number; stdout?: string; stderr?: string };
    if (res.code === 0) {
      return {
        ok: true,
        message: 'Restarted auth.service. Re-check in ~20 s; if discovery still fails the underlying cause is still present.',
        refresh: true,
      };
    }
    const err = (res.stderr ?? res.stdout ?? '').trim().slice(0, 200) || `exit ${res.code}`;
    return {
      ok: false,
      message: `Could not restart auth.service: ${err}.`,
      refresh: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`diagnose:${PROBE_ID}`, `restart action threw: ${message}`);
    return {
      ok: false,
      message: `Restart failed: ${message}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_recent_logs',
    label: 'Show recent logs',
    description:
      'Fetches the last 50 lines of `podman logs auth-authelia` and renders them inline — enough to identify the exact failure mode (config error, LDAP bind, storage decrypt) without SSH-ing into the box.',
  },
  showRecentLogs,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'restart_authelia',
    label: 'Restart auth',
    description:
      'Restarts auth.service via systemctl. Use after fixing the underlying cause (config edit, LLDAP re-seed). Storage encryption key drift will NOT recover from a restart — use the Reset wizard for that.',
  },
  restartAuthelia,
);
