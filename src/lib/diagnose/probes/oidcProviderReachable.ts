/**
 * `oidc_provider_reachable` probe (#623) — surfaces the case where
 * Authelia's container is "up" but its OIDC discovery endpoint
 * doesn't answer with a parseable 200. Sister-probe to
 * `crash_loop` (which catches container-level loops) and to
 * `domain_external_reachability` (which only checks DNS):
 * specifically catches the layer between "container up" and "SSO
 * actually works".
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

import { getConfig } from '@/lib/config';

export interface OidcProviderResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

// Authelia's default port inside the auth pod. Hard-coded here to keep
// the probe free of template-discovery overhead — if a future install
// rebinds Authelia to a different port the value lives in env
// (AUTHELIA_PORT), so honour that first.
const AUTHELIA_DEFAULT_PORT = 9091;
const DISCOVERY_TIMEOUT_MS = 4000;

function buildDiscoveryUrl(): string {
  const port = parseInt(process.env.AUTHELIA_PORT || '', 10);
  const effective = Number.isFinite(port) && port > 0 ? port : AUTHELIA_DEFAULT_PORT;
  return `http://127.0.0.1:${effective}/.well-known/openid-configuration`;
}

export async function checkOidcProviderReachable(): Promise<OidcProviderResult> {
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
    return {
      status: 'fail',
      detail: `Authelia OIDC discovery (${url}) did not respond: ${reason}`,
      hint: 'Authelia is likely crash-looping or wedged on a storage/LDAP error. Check `podman logs auth-authelia` for fatal-level messages. Most common cause: a reinstall left the preserved DB encryption key out of sync with the new config — wipe authelia-data/db.sqlite3 + lldap/users.db, restart auth, re-add LLDAP users.',
    };
  }

  if (response.status !== 200) {
    return {
      status: 'fail',
      detail: `Authelia OIDC discovery returned HTTP ${response.status} (expected 200). Every SSO-gated service will be returning 502 to users right now.`,
      hint: 'Common causes: Authelia config invalid (check `podman logs auth-authelia` for "Configuration:" errors), LDAP bind failing against LLDAP (Invalid Credentials), or storage encryption key drift from a reinstall. Restarting auth.service alone usually does not fix this — the config or DB state needs attention first.',
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
      hint: 'Likely an Authelia config that disabled some endpoints, or an in-progress upgrade. SSO clients that need those endpoints will fail.',
    };
  }

  return {
    status: 'ok',
    detail: `Authelia OIDC discovery answers 200 with a valid configuration document.`,
  };
}
