/**
 * In-process SSO end-to-end verification (#1453) — the foundation #1454
 * (auto-run post-install) and #1455 (one-click UI report) build on.
 *
 * Ports the core of `scripts/smoke/sso-verify.sh` into a callable async
 * function, dropping the dev-SSH-key dependency: the backend already runs
 * *on the box*, so it talks to LLDAP / Authelia / NPM over localhost and
 * runs the in-container `lldap_set_password` binary through the agent exec
 * channel (the same channel the oidc/failed-units probes use), not SSH.
 *
 * The flow, mirroring the smoke test's user-facing path:
 *   1. resolve config (publicDomain, lldap url) + the `family` group id;
 *   2. create a clearly-namespaced **ephemeral** LLDAP user, password held
 *      only in memory, joined to `family`;
 *   3. log it in through Authelia's `/api/firstfactor`, capture the
 *      session cookie;
 *   4. hit every user-facing service domain with the cookie, expecting
 *      2xx/3xx (+ a content signature where one is stable);
 *   5. confirm the user is **rejected** by admin-only domains (302/401/403,
 *      never 2xx);
 *   6. **always** delete the ephemeral user — on success *and* failure.
 *
 * Returns a structured per-step / per-domain report. No UI, no scheduling,
 * no auto-trigger — those are the consumers' job.
 *
 * Admin-path (section 7) and box-health / portal-asset (sections 1, 8) of
 * the bash script are intentionally out of scope for this foundation: the
 * positive-admin path needs a second user with 2FA semantics, and box
 * health is already covered by existing health checks. The deliverable is
 * the user-facing create→login→domain→admin-reject→delete spine.
 */

import { randomBytes } from 'node:crypto';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { AUTHELIA_FORWARD_AUTH_SENTINEL } from '@/lib/stackInstall/forwardAuth';
import {
  createLldapUser,
  addUserToLldapGroup,
  deleteLldapUser,
  listLldapGroups,
  getLldapAdminToken,
} from '@/lib/lldap/client';

const AUTHELIA_DEFAULT_PORT = 9091;
const LLDAP_CONTAINER = 'auth-lldap';
const HTTP_TIMEOUT_MS = 8000;
const SET_PASSWORD_TIMEOUT_MS = 15_000;

/**
 * User-facing service subdomain → optional content signature. An empty
 * signature means "2xx/3xx is enough"; a non-empty one is grepped in the
 * body so the check also catches "200 with the wrong content" (a half-broken
 * proxy).
 *
 * `ollama` was added (#1685): its proxy host now carries Authelia
 * forward-auth (`auth_request /authelia`) — the old "no auth, opt-in host"
 * premise (#1180) is false, and a real authorized user got a 403 this run.
 * It's only *probed* when its host actually carries forward-auth (derived
 * at runtime via `hostHasForwardAuth`), so a future un-gated ollama host
 * won't false-fail. The authed root answers `Ollama is running`.
 *
 * `hermes` was dropped (#1591): it's an external OSCAR service with no
 * ServiceBay template, so it has no entry in `installedTemplates` to gate on
 * and would always 404 a non-OSCAR install into a false `fail`.
 */
export const USER_APP_SIGNATURES: Readonly<Record<string, string>> = {
  vault: 'Vaultwarden Web',
  photos: '',
  home: '',
  files: '',
  sync: '',
  caldav: '',
  // `music`/`books` were RETIRED: Jellyfin is one general media server at
  // `media.<domain>` now (#media-rename), and it does its OWN auth (LDAP-Auth →
  // LLDAP), NOT Authelia forward-auth/OIDC — so a reachability probe here told us
  // nothing about whether login works (it 200s on the login page regardless). It
  // is verified end-to-end instead by the dedicated Jellyfin LDAP-login check
  // below (probeJellyfinLogin) — that's what would have caught the missing
  // LDAP-Auth plugin that locked everyone out 2026-06-21.
  // ollama is intentionally absent: it's admin-only, not a family-reachable app
  // (the chat uses ollama over internal loopback, not this gated host). See
  // FORWARD_AUTH_DERIVED_SUBDOMAINS.
};

/**
 * Subdomain prefix → the template whose installation puts that proxy host on
 * the box (#1591). Only subdomains whose backing template is present in
 * `cfg.installedTemplates` are probed; an absent service is *not* a failure,
 * it's simply not installed. `file-share` backs two hosts (files + sync).
 */
export const SUBDOMAIN_TEMPLATE: Readonly<Record<string, string>> = {
  vault: 'vaultwarden',
  photos: 'immich',
  home: 'home-assistant',
  files: 'file-share',
  sync: 'file-share',
  caldav: 'radicale',
  // `media` (Jellyfin) is intentionally absent — it isn't a forward-auth/OIDC
  // host; its login is verified by probeJellyfinLogin, gated on installedTemplates.media.
};

/**
 * Subdomains with no first-class ServiceBay template (so they can't gate on
 * `installedTemplates`, like `hermes` #1591) but which ARE forward-auth
 * proxy hosts when the operator opted them in. They're probed iff their
 * proxy host carries `auth_request /authelia` (derived at runtime via
 * `hostHasForwardAuth`) — never by template presence. `ollama` (#1685) is
 * the first: it's installed by the external honcho/OSCAR stack and got a
 * forward-auth NPM host this run.
 */
// Empty by operator decision: `ollama.dopp.cloud` is ADMIN-ONLY, not a family app.
// The solaris chat reaches ollama over internal loopback (`OLLAMA_URL=
// http://127.0.0.1:11434`), NOT this Authelia-gated public host — so a family user
// never needs it and probing it as a family-reachable app was wrong (it returns 403
// to family). Genuinely enforcing admin-only on it (an Authelia access rule) +
// verifying via the admin-reject check is a follow-up tied to the auth template.
export const FORWARD_AUTH_DERIVED_SUBDOMAINS: readonly string[] = [];

/**
 * Subdomains backed by their OWN OIDC client (not Authelia forward-auth):
 * reachability-only would pass even when the OIDC handshake is broken (the
 * app's login page still renders 200). For these we additionally drive the
 * real OIDC authorization flow and assert it reaches a redirect with a code
 * — not `invalid_client`/`server_error` (#1685, the #1559 immich case).
 *
 * Maps the subdomain → its Authelia `client_id` AND the client's REGISTERED
 * redirect path (the first entry of the template's `oidcClient.redirect_uris`).
 * The probe MUST send a redirect_uri that matches one the client is registered
 * with, or Authelia (correctly, as a security control) rejects it with
 * `invalid_request`. The old probe sent a placeholder `https://auth.<domain>/`
 * for EVERY client → it always failed and mislabelled the legitimate rejection
 * as a broken secret. The real redirect_uri is
 * `https://<subdomain>.<publicDomain><redirectPath>`.
 */
export const OIDC_CLIENT_SUBDOMAINS: Readonly<Record<string, { clientId: string; redirectPath: string }>> = {
  vault: { clientId: 'vaultwarden', redirectPath: '/identity/connect/oidc-signin' },
  photos: { clientId: 'immich', redirectPath: '/auth/login' },
  // `books`/audiobookshelf was retired (#1725) — Jellyfin serves audiobooks now
  // and authenticates via LDAP, not OIDC. Verified by probeJellyfinLogin instead.
};

/**
 * Admin-only subdomains a `family`-group user must NOT reach. `admin`
 * (ServiceBay itself) is deliberately excluded — it has app-layer auth, not
 * Authelia forward-auth (matches the smoke test's reasoning).
 */
export const ADMIN_ONLY_HOSTS: readonly string[] = ['nginx', 'dns', 'ldap'];

export type SsoStepStatus = 'pass' | 'fail' | 'skip';

export interface SsoStepResult {
  /** Stable step id, e.g. `create_user`, `authelia_firstfactor`. */
  id: string;
  status: SsoStepStatus;
  detail: string;
}

export interface SsoDomainResult {
  /** Fully-qualified host, e.g. `vault.dopp.cloud`. */
  domain: string;
  status: SsoStepStatus;
  /** HTTP status code observed (0 = transport error). */
  code: number;
  detail: string;
}

export interface SsoVerifyReport {
  ok: boolean;
  /**
   * True when the test itself couldn't be set up (e.g. the ephemeral user's
   * password couldn't be set) — as opposed to a real login/access failure.
   * "Couldn't run the test" must NOT read as "SSO is broken" (#1673): the
   * probe maps this to a warn, not a red fail that scares an operator toward
   * an unnecessary reinstall. Always implies `ok === false`.
   */
  couldNotRun: boolean;
  /** True if the ephemeral user was created and successfully deleted again. */
  cleanedUp: boolean;
  /** The ephemeral username that was used (for log correlation). */
  ephemeralUser: string;
  steps: SsoStepResult[];
  userDomains: SsoDomainResult[];
  adminDomains: SsoDomainResult[];
}

/** A single domain probe outcome before classification. */
export interface DomainProbe {
  code: number;
  body: string;
  error?: string;
}

/** Outcome of driving a service's OIDC authorization endpoint. */
export interface OidcAuthProbe {
  /** True when Authelia issued an authorization `code` (consent/redirect). */
  ok: boolean;
  /** HTTP status of the /api/oidc/authorization response (0 = transport). */
  code: number;
  /** The OAuth2 `error` Authelia returned, if any (e.g. `invalid_client`). */
  oauthError?: string;
  detail: string;
}

/** Outcome of attempting a real Jellyfin login as the ephemeral LLDAP user.
 *  `ok` ⇒ Jellyfin's LDAP-Auth plugin authenticated the LLDAP user end-to-end. */
export interface JellyfinLoginProbe {
  ok: boolean;
  /** HTTP status of /Users/AuthenticateByName (0 = transport error). */
  code: number;
  detail: string;
}

export interface SsoVerifyDeps {
  createUser: typeof createLldapUser;
  addToGroup: typeof addUserToLldapGroup;
  deleteUser: typeof deleteLldapUser;
  listGroups: typeof listLldapGroups;
  /** Set the ephemeral user's password via the in-container binary. */
  setPassword: (userId: string, password: string) => Promise<{ ok: boolean; message: string }>;
  /** POST Authelia firstfactor; resolves the session cookie or null. */
  autheliaFirstFactor: (
    publicDomain: string,
    username: string,
    password: string,
  ) => Promise<{ ok: boolean; cookie: string | null; detail: string }>;
  /** Probe one proxied domain, optionally carrying the session cookie. */
  probeDomain: (
    publicDomain: string,
    host: string,
    cookie: string | null,
    followRedirects: boolean,
  ) => Promise<DomainProbe>;
  /**
   * Ask Authelia DIRECTLY whether the signed-in family user is allowed to reach
   * an admin host — by querying its forward-auth decision endpoint
   * (`/api/authz/auth-request`) with the cookie + `X-Original-URL`, exactly the
   * subrequest nginx makes. `200` = Authelia ALLOWS (a family user reaching an
   * admin host = bypass); `401/403` = correctly denied. This replaces hitting the
   * host on `http:80`, where the first hop is the HTTP→HTTPS 301 — before the auth
   * decision — so the old probe never saw the real deny and false-flagged a bypass
   * (#admin-acl-port). The `code` maps straight into {@link classifyAdminReject}.
   */
  probeAdminDecision: (publicDomain: string, host: string, cookie: string | null) => Promise<DomainProbe>;
  /** True iff the proxy host for `host` carries `auth_request /authelia`
   *  forward-auth — so a host is probed because it IS gated, not because a
   *  hard-coded list says so (#1685). */
  hostHasForwardAuth: (host: string) => Promise<boolean>;
  /** Drive a service's OIDC authorization flow as the signed-in ephemeral
   *  user and report whether Authelia issued a real `code` (#1685). The
   *  `redirectUri` MUST be one the client is registered with, else Authelia
   *  rejects the request (`invalid_request`) regardless of client health. */
  probeOidcAuthorization: (
    publicDomain: string,
    clientId: string,
    redirectUri: string,
    cookie: string,
  ) => Promise<OidcAuthProbe>;
  /** Log into Jellyfin (`media`) AS the ephemeral LLDAP user via its LDAP-Auth
   *  plugin — the only end-to-end check that the plugin is installed AND can bind
   *  LLDAP. Jellyfin does its own auth (not Authelia), so nothing else covers this;
   *  a missing plugin silently locked everyone out 2026-06-21. */
  probeJellyfinLogin: (ephemeralUser: string, password: string) => Promise<JellyfinLoginProbe>;
}

export interface SsoVerifyOptions {
  node?: string;
  /** Override deps for testing; defaults wire the real LLDAP/Authelia/NPM. */
  deps?: Partial<SsoVerifyDeps>;
}

// ---------------------------------------------------------------------------
// Pure classifiers (unit-tested directly).
// ---------------------------------------------------------------------------

/** A unique, clearly-namespaced ephemeral username that won't collide with a
 *  real account or a concurrent run. */
export function makeEphemeralUsername(now: number = Date.now()): string {
  return `sb-ssoverify-${now}-${randomBytes(3).toString('hex')}`;
}

/** Classify a user-facing domain probe: 2xx/3xx passes (and matches the
 *  signature if one is given); anything else fails. */
export function classifyUserDomain(host: string, signature: string, probe: DomainProbe): SsoDomainResult {
  const domain = host; // caller passes the FQDN
  if (probe.error || probe.code === 0) {
    return { domain, status: 'fail', code: 0, detail: `transport error: ${probe.error ?? 'no response'}` };
  }
  const reachable = (probe.code >= 200 && probe.code < 400);
  if (!reachable) {
    return { domain, status: 'fail', code: probe.code, detail: `HTTP ${probe.code} (auth or upstream broken)` };
  }
  if (signature && !probe.body.includes(signature)) {
    return { domain, status: 'fail', code: probe.code, detail: `HTTP ${probe.code} but body missing signature "${signature}"` };
  }
  return { domain, status: 'pass', code: probe.code, detail: `HTTP ${probe.code}${signature ? ` (matched "${signature}")` : ''}` };
}

/** Classify an admin-only domain probe for a family-only user: a redirect to
 *  auth (302/303) or an Authelia refusal (401/403) is the PASS signal; a 2xx
 *  means the ACL was bypassed. */
export function classifyAdminReject(host: string, probe: DomainProbe): SsoDomainResult {
  const domain = host;
  if (probe.error || probe.code === 0) {
    return { domain, status: 'fail', code: 0, detail: `transport error: ${probe.error ?? 'no response'} (can't judge ACL)` };
  }
  if ([302, 303, 401, 403].includes(probe.code)) {
    return { domain, status: 'pass', code: probe.code, detail: `HTTP ${probe.code} (correctly blocked for family-only user)` };
  }
  if (probe.code >= 200 && probe.code < 300) {
    return { domain, status: 'fail', code: probe.code, detail: `HTTP ${probe.code}: family user got in — ACL bypassed` };
  }
  return { domain, status: 'fail', code: probe.code, detail: `HTTP ${probe.code} (unexpected — can't judge ACL)` };
}

/**
 * Decide an OIDC authorization outcome from the response's `Location` header.
 * Returns a probe result when the location is decisive, or `null` when it's
 * inconclusive (the caller then inspects the body). Three healthy/known cases:
 *  - an OAuth `error=` in the location → fail (registration/config fault).
 *  - a `code=` → the full handshake completed → pass.
 *  - a redirect to Authelia's `/consent` screen → HEALTHY handshake (client +
 *    redirect_uri + scope accepted AND the user authenticated; only the human
 *    "Approve" click remains, which the probe can't do and a real user does once).
 *    Treating consent as pass is the fix for vault/immich's false "login broken":
 *    a first-time / non-pre-consented client 302s here, not straight to `code=`
 *    (#sso-redirect-uri). Exported for unit testing.
 */
export function classifyOidcRedirect(location: string, status: number): OidcAuthProbe | null {
  const oauthError = extractOauthError(location);
  if (oauthError) return { ok: false, code: status, oauthError, detail: `Authelia returned OAuth error "${oauthError}"` };
  if (location.includes('code=')) return { ok: true, code: status, detail: 'authorization code issued' };
  if (/\/consent(\/|\?|$)/.test(location)) {
    return { ok: true, code: status, detail: 'reached the OIDC consent screen (handshake healthy; awaits user approval)' };
  }
  return null;
}

/** Classify an OIDC authorization probe for an OIDC-backed app. A real
 *  `code` (consent/redirect) passes; `invalid_client`/`server_error` (the
 *  broken-secret signature, #1559) or any non-redirect fails. Reachability
 *  alone is NOT enough — the app's login page renders 200 even when the
 *  handshake is broken (#1685). */
export function classifyOidcAuthorization(host: string, clientId: string, probe: OidcAuthProbe): SsoDomainResult {
  const domain = host;
  if (probe.ok) {
    return { domain, status: 'pass', code: probe.code, detail: `OIDC authorization issued a code for client "${clientId}" (handshake healthy)` };
  }
  if (probe.oauthError) {
    // `invalid_client` / `unauthorized_client` / `access_denied` / `server_error`
    // are genuine client-registration/config problems. The authorization endpoint
    // does NOT validate the client SECRET (that's the token exchange), so this is a
    // registration/config fault, not a "secret mismatch". A bare `invalid_request`
    // means Authelia rejected the probe's REQUEST (e.g. a redirect_uri we no longer
    // build wrong) — treat that as "couldn't validly test" (skip), never a red
    // "login broken" that scares toward a needless reinstall (#sso-redirect-uri).
    if (probe.oauthError === 'invalid_request') {
      return { domain, status: 'skip', code: probe.code, detail: `OIDC authorization probe for "${clientId}" could not run (Authelia: invalid_request — likely a probe/redirect_uri setup issue, not a service fault)` };
    }
    return { domain, status: 'fail', code: probe.code, detail: `OIDC authorization for "${clientId}" returned ${probe.oauthError} — client registration/config problem (login is affected)` };
  }
  if (probe.code === 0) {
    return { domain, status: 'fail', code: 0, detail: `OIDC authorization for "${clientId}" did not respond: ${probe.detail}` };
  }
  return { domain, status: 'fail', code: probe.code, detail: `OIDC authorization for "${clientId}" did not reach a redirect (HTTP ${probe.code}): ${probe.detail}` };
}

/** Classify the Jellyfin LDAP-login probe. `ok` ⇒ the LDAP-Auth plugin
 *  authenticated the LLDAP user end-to-end (plugin installed + LLDAP bind works).
 *  A transport error (code 0) is "couldn't test" (skip) — Jellyfin may simply be
 *  down/restarting — not a login-broken fail that scares toward a reinstall. */
export function classifyJellyfinLogin(host: string, probe: JellyfinLoginProbe): SsoDomainResult {
  if (probe.ok) {
    return { domain: host, status: 'pass', code: probe.code, detail: probe.detail };
  }
  if (probe.code === 0) {
    return { domain: host, status: 'skip', code: 0, detail: `Jellyfin LDAP-login probe could not run (Jellyfin unreachable): ${probe.detail}` };
  }
  return { domain: host, status: 'fail', code: probe.code, detail: probe.detail };
}

/** Pull the `authelia_session` cookie value out of a Set-Cookie header list. */
export function extractAutheliaCookie(setCookies: string[]): string | null {
  for (const sc of setCookies) {
    const m = /(?:^|;\s*)(authelia_session=[^;]+)/.exec(sc) ?? /^(authelia_session=[^;]+)/.exec(sc.trim());
    if (m) return m[1];
  }
  return null;
}

function autheliaPort(): number {
  const p = parseInt(process.env.AUTHELIA_PORT || '', 10);
  return Number.isFinite(p) && p > 0 ? p : AUTHELIA_DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Real dependency implementations (the localhost / agent-exec wiring).
// ---------------------------------------------------------------------------

function realSetPassword(node: string) {
  // The username/password are module-generated (safe charset) but the
  // command still runs in a shell, so the password is single-quoted and we
  // refuse any value that could break out of the quoting.
  return async (userId: string, password: string): Promise<{ ok: boolean; message: string }> => {
    if (/['"\\\n`$]/.test(password) || !/^[a-z0-9-]+$/i.test(userId)) {
      return { ok: false, message: 'ephemeral credentials failed the safe-charset guard' };
    }
    // #1673: `lldap_set_password` requires a credential — the previous
    // credential-less invocation always failed ("Either the token or the
    // admin password is required") and false-red the whole probe on a
    // healthy box. Mint an admin JWT via the SAME `/auth/simple/login`
    // path createUser/listGroups already use and pass it as `--token`.
    const adminAuth = await getLldapAdminToken();
    if (!adminAuth.ok) {
      return { ok: false, message: `could not obtain an LLDAP admin token to set the password: ${adminAuth.message}` };
    }
    // The token is base64url JWT (no shell-special chars), but guard anyway
    // since it is interpolated into the shell command.
    if (/['"\\\n`$\s]/.test(adminAuth.token)) {
      return { ok: false, message: 'LLDAP admin token contained unexpected characters; refusing to interpolate it into the command' };
    }
    const agent = await agentManager.ensureAgent(node);
    const res = await agent.sendCommand('exec', {
      command:
        `podman exec ${LLDAP_CONTAINER} /app/lldap_set_password ` +
        `-u ${userId} -p '${password}' --base-url ${adminAuth.baseUrl} ` +
        `--token '${adminAuth.token}' 2>&1`,
    }, { timeoutMs: SET_PASSWORD_TIMEOUT_MS }) as { code?: number; stdout?: string; stderr?: string };
    const out = (res.stdout ?? res.stderr ?? '').trim();
    if (res.code === 0 || /Successfully changed/i.test(out)) {
      return { ok: true, message: 'password set' };
    }
    return { ok: false, message: `lldap_set_password returned ${res.code}: ${out.slice(0, 200) || 'unknown error'}` };
  };
}

async function realAutheliaFirstFactor(
  publicDomain: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; cookie: string | null; detail: string }> {
  const url = `http://127.0.0.1:${autheliaPort()}/api/firstfactor`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: `auth.${publicDomain}`,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': `auth.${publicDomain}`,
      },
      body: JSON.stringify({
        username,
        password,
        requestMethod: 'GET',
        targetURL: `https://vault.${publicDomain}/`,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (res.status !== 200 || !text.includes('"status":"OK"')) {
      return { ok: false, cookie: null, detail: `firstfactor HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    const cookie = extractAutheliaCookie(res.headers.getSetCookie?.() ?? []);
    if (!cookie) return { ok: false, cookie: null, detail: 'firstfactor OK but no authelia_session cookie set' };
    return { ok: true, cookie, detail: 'firstfactor OK, session cookie captured' };
  } catch (e) {
    return { ok: false, cookie: null, detail: `firstfactor request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Probe a proxied service via NPM on the box (localhost:80) with a Host
 *  header — the in-process analogue of the smoke test's `--resolve`. */
async function realProbeDomain(
  publicDomain: string,
  host: string,
  cookie: string | null,
  followRedirects: boolean,
): Promise<DomainProbe> {
  const fqdn = `${host}.${publicDomain}`;
  const headers: Record<string, string> = {
    Host: fqdn,
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': fqdn,
  };
  if (cookie) headers['Cookie'] = cookie;
  try {
    const res = await fetch('http://127.0.0.1:80/', {
      method: 'GET',
      headers,
      redirect: followRedirects ? 'follow' : 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => '');
    return { code: res.status, body };
  } catch (e) {
    return { code: 0, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask Authelia's forward-auth decision endpoint whether the family user may reach
 * an admin host — the same `/api/authz/auth-request` subrequest nginx makes (the
 * proven shape from portal/auth.ts: Cookie + X-Original-URL + X-Original-Method,
 * no Host override). 200 = allowed (= bypass for a family user on an admin host);
 * 401/403 = correctly denied. This is the real ACL decision, on plain http
 * loopback — no TLS, and far more precise than scraping the host's HTTP status.
 */
export async function realProbeAdminDecision(publicDomain: string, host: string, cookie: string | null): Promise<DomainProbe> {
  const originalUrl = `https://${host}.${publicDomain}/`;
  try {
    const res = await fetch(`http://127.0.0.1:${autheliaPort()}/api/authz/auth-request`, {
      method: 'GET',
      headers: {
        'X-Original-URL': originalUrl,
        'X-Original-Method': 'GET',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return { code: res.status, body: '' };
  } catch (e) {
    return { code: 0, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}


/** Resolve NPM's admin API base URL on this node (the admin port, not 80/443).
 *  Mirrors the local helper in danglingProxy.ts; kept local to avoid coupling. */
async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    const adminPort = ports[0] ?? 81;
    return `http://localhost:${adminPort}`;
  } catch {
    return null;
  }
}

/** Mint an NPM admin bearer token (stored creds first, then NPM defaults). */
async function getNpmToken(adminUrl: string): Promise<string | null> {
  const config = await getConfig();
  const candidates: { identity: string; secret: string }[] = [];
  const stored = config.reverseProxy?.npm;
  if (stored?.email && stored?.password) candidates.push({ identity: stored.email, secret: stored.password });
  candidates.push({ identity: 'admin@example.com', secret: 'changeme' });
  for (const cred of candidates) {
    try {
      const res = await fetch(`${adminUrl}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cred),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.token === 'string') return data.token;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** True iff the NPM proxy host for `host.<publicDomain>` carries Authelia
 *  forward-auth. Derives gating from the host's ACTUAL `advanced_config`
 *  (the forward-auth sentinel / `auth_request /authelia` snippet the
 *  installer writes into NPM) rather than a hard-coded include/exclude list
 *  (#1685). A host NPM doesn't know about, or one carrying no forward-auth,
 *  returns false — so we never probe an un-gated host as if it required SSO.
 *  Read failures are treated as "not gated" (the probe degrades to skipping
 *  the host rather than false-failing). */
function realHostHasForwardAuth(node: string) {
  return async (fqdn: string): Promise<boolean> => {
    const adminUrl = await findNpmAdminUrl(node);
    if (!adminUrl) return false;
    const token = await getNpmToken(adminUrl);
    if (!token) return false;
    try {
      const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts?expand=owner`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const hosts = await res.json() as Array<{ domain_names?: string[]; advanced_config?: string }>;
      if (!Array.isArray(hosts)) return false;
      const entry = hosts.find(h => (h.domain_names ?? []).includes(fqdn));
      const adv = entry?.advanced_config ?? '';
      return adv.includes(AUTHELIA_FORWARD_AUTH_SENTINEL) || /auth_request\s+\/authelia/.test(adv);
    } catch {
      return false;
    }
  };
}

/** Drive a service's OIDC authorization endpoint as the signed-in ephemeral
 *  user and report whether Authelia issued a real `code`. A healthy client
 *  redirects (302) to the service's redirect_uri carrying `?code=…`; a
 *  broken secret/registration answers `invalid_client`/`server_error`
 *  (#1559). The session cookie short-circuits the consent screen for a
 *  one_factor client. */
export async function realProbeOidcAuthorization(
  publicDomain: string,
  clientId: string,
  redirectUri: string,
  cookie: string,
): Promise<OidcAuthProbe> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state: 'sb-ssoverify',
  });
  const url = `http://127.0.0.1:${autheliaPort()}/api/oidc/authorization?${params.toString()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Host: `auth.${publicDomain}`,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': `auth.${publicDomain}`,
        Cookie: cookie,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const location = res.headers.get('location') ?? '';
    const byLocation = classifyOidcRedirect(location, res.status);
    if (byLocation) return byLocation;
    // Inconclusive redirect/location — fall back to the body: it may be a
    // non-redirect error page that names the OAuth error.
    const body = await res.text().catch(() => '');
    const bodyError = extractOauthError(body);
    if (bodyError) {
      return { ok: false, code: res.status, oauthError: bodyError, detail: `Authelia body reported "${bodyError}"` };
    }
    return { ok: false, code: res.status, detail: location ? `redirected without a code → ${location.slice(0, 120)}` : `no redirect (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, code: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

// Jellyfin's fixed container port (templates/media/template.yml) + the
// X-Emby-Authorization client identifier every /Users/AuthenticateByName needs
// (the server 400s without it).
const JELLYFIN_PORT = 8096;
function jellyfinAuthHeader(deviceId: string, token?: string): string {
  const base = `MediaBrowser Client="servicebay-ssoverify", Device="servicebay", DeviceId="${deviceId}", Version="1"`;
  return token ? `${base}, Token="${token}"` : base;
}

/** Log into Jellyfin AS the ephemeral LLDAP user through its LDAP-Auth plugin.
 *  A `200` + AccessToken proves the plugin is installed AND bound LLDAP — the only
 *  end-to-end check of Jellyfin's (non-Authelia) auth. `401` ⇒ the plugin is
 *  missing/misconfigured (the exact silent break of 2026-06-21). A successful
 *  login auto-creates a Jellyfin profile (`CreateUsersFromLdap`), so we delete it
 *  again (best-effort, via the stored admin creds) to avoid orphan accrual. */
export async function realProbeJellyfinLogin(ephemeralUser: string, password: string): Promise<JellyfinLoginProbe> {
  const base = `http://127.0.0.1:${JELLYFIN_PORT}`;
  const deviceId = `sb-ssoverify-${randomBytes(3).toString('hex')}`;
  try {
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': jellyfinAuthHeader(deviceId) },
      body: JSON.stringify({ Username: ephemeralUser, Pw: password }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return {
        ok: false,
        code: res.status,
        detail: `Jellyfin rejected the LLDAP login (HTTP ${res.status}) — LDAP-Auth plugin missing or its LLDAP bind is broken`,
      };
    }
    const body = (await res.json().catch(() => null)) as { AccessToken?: string; User?: { Id?: string } } | null;
    if (!body?.AccessToken) {
      return { ok: false, code: 200, detail: 'Jellyfin returned 200 but no AccessToken — LDAP-Auth not actually authenticating' };
    }
    const cleaned = await cleanupJellyfinProfile(base, body.User?.Id);
    return {
      ok: true,
      code: 200,
      detail: cleaned
        ? 'Jellyfin authenticated the LLDAP user (LDAP-Auth plugin healthy)'
        : 'Jellyfin authenticated the LLDAP user (LDAP-Auth healthy) — but the ephemeral test profile was left behind (admin cleanup unavailable)',
    };
  } catch (e) {
    return { ok: false, code: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Delete the Jellyfin profile auto-created by the probe login. Best-effort:
 *  mints an admin token from the stored `JELLYFIN_ADMIN_PASSWORD` (decrypted by
 *  getConfig) and DELETEs the user. Returns false (never throws) when the admin
 *  creds are unavailable/drifted — the login result must not hinge on cleanup. */
export async function cleanupJellyfinProfile(base: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const config = await getConfig();
    const adminPw = config.installedSecrets?.find(s => s.varName === 'JELLYFIN_ADMIN_PASSWORD')?.password;
    if (!adminPw) return false;
    const deviceId = `sb-ssoverify-cleanup-${randomBytes(3).toString('hex')}`;
    const auth = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': jellyfinAuthHeader(deviceId) },
      body: JSON.stringify({ Username: 'admin', Pw: adminPw }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (auth.status !== 200) return false;
    const token = ((await auth.json().catch(() => null)) as { AccessToken?: string } | null)?.AccessToken;
    if (!token) return false;
    const del = await fetch(`${base}/Users/${userId}`, {
      method: 'DELETE',
      headers: { 'X-Emby-Authorization': jellyfinAuthHeader(deviceId, token) },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return del.status === 200 || del.status === 204;
  } catch {
    return false;
  }
}

/** Pull an OAuth2 `error=` code out of a redirect Location or a JSON/HTML
 *  error body. Returns the bare error token (e.g. `invalid_client`). */
export function extractOauthError(text: string): string | undefined {
  const fromQuery = /[?&#]error=([a-z_]+)/i.exec(text);
  if (fromQuery) return fromQuery[1];
  const fromJson = /"error"\s*:\s*"([a-z_]+)"/i.exec(text);
  if (fromJson) return fromJson[1];
  return undefined;
}

function buildDeps(node: string, overrides?: Partial<SsoVerifyDeps>): SsoVerifyDeps {
  return {
    createUser: createLldapUser,
    addToGroup: addUserToLldapGroup,
    deleteUser: deleteLldapUser,
    listGroups: listLldapGroups,
    setPassword: realSetPassword(node),
    autheliaFirstFactor: realAutheliaFirstFactor,
    probeDomain: realProbeDomain,
    probeAdminDecision: realProbeAdminDecision,
    hostHasForwardAuth: realHostHasForwardAuth(node),
    probeOidcAuthorization: realProbeOidcAuthorization,
    probeJellyfinLogin: realProbeJellyfinLogin,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/** Internal mutable accumulator threaded through the flow helpers. */
interface SsoRun {
  publicDomain: string;
  ephemeralUser: string;
  password: string;
  /** Templates installed on this node — gates which user subdomains we probe. */
  installedTemplates: Record<string, unknown>;
  steps: SsoStepResult[];
  userDomains: SsoDomainResult[];
  adminDomains: SsoDomainResult[];
  created: boolean;
  /**
   * Set when a *setup* step (provisioning the ephemeral test user) failed,
   * so we never even reached the real login/access test (#1673). The verdict
   * becomes "couldn't run the test" (warn), NOT "SSO is broken" (red fail) —
   * a setup failure must not scare an operator toward a reinstall.
   */
  setupFailed: boolean;
}

/** The user subdomains to probe on this install: only those whose backing
 *  template is installed. A subdomain with no known template is never probed
 *  (so an external/untemplated service can't false-fail the run). */
export function probeableUserSubdomains(installedTemplates: Record<string, unknown>): string[] {
  return Object.keys(USER_APP_SIGNATURES).filter(host => {
    const template = SUBDOMAIN_TEMPLATE[host];
    return template != null && installedTemplates[template] != null;
  });
}

/** Create the ephemeral user, set its password, and join `family`. Returns
 *  false on the first failing step (caller then funnels through cleanup). */
async function provisionEphemeralUser(deps: SsoVerifyDeps, run: SsoRun): Promise<boolean> {
  const groups = await deps.listGroups();
  if (!groups.ok) {
    run.steps.push({ id: 'list_groups', status: 'fail', detail: `could not read LLDAP groups: ${groups.message}` });
    run.setupFailed = true;
    return false;
  }
  const family = groups.groups.find(g => g.displayName === 'family');
  if (!family) {
    run.steps.push({ id: 'family_group', status: 'fail', detail: "no 'family' group in LLDAP — Authelia's user rules expect it." });
    run.setupFailed = true;
    return false;
  }
  run.steps.push({ id: 'family_group', status: 'pass', detail: `'family' group present (id=${family.id})` });

  const create = await deps.createUser({ id: run.ephemeralUser, email: `${run.ephemeralUser}@${run.publicDomain}`, displayName: 'SSO Verify (ephemeral)' });
  if (!create.ok) {
    run.steps.push({ id: 'create_user', status: 'fail', detail: `createUser failed: ${create.message}` });
    run.setupFailed = true;
    return false;
  }
  run.created = true;
  run.steps.push({ id: 'create_user', status: 'pass', detail: `created ${run.ephemeralUser}` });

  const pw = await deps.setPassword(run.ephemeralUser, run.password);
  run.steps.push({ id: 'set_password', status: pw.ok ? 'pass' : 'fail', detail: pw.ok ? 'password set via the LLDAP admin token' : `couldn't set the test user's password (test setup, not a login failure): ${pw.message}` });
  if (!pw.ok) {
    run.setupFailed = true;
    return false;
  }

  const grp = await deps.addToGroup(run.ephemeralUser, family.id);
  run.steps.push({ id: 'join_family', status: grp.ok ? 'pass' : 'fail', detail: grp.ok ? 'joined family group' : `addUserToGroup failed: ${grp.message}` });
  if (!grp.ok) run.setupFailed = true;
  return grp.ok;
}

/** Forward-auth (reachability + cookie) check for one host: the genuine
 *  SSO test for an Authelia-gated app — login → cookie → access. */
async function probeForwardAuthHost(deps: SsoVerifyDeps, run: SsoRun, host: string, cookie: string): Promise<void> {
  const signature = USER_APP_SIGNATURES[host] ?? '';
  const probe = await deps.probeDomain(run.publicDomain, host, cookie, true);
  run.userDomains.push(classifyUserDomain(`${host}.${run.publicDomain}`, signature, probe));
}

/** OIDC-client check for one host: exercise the real /api/oidc/authorization
 *  flow and assert a code is issued — reachability alone passes even when the
 *  client secret is mismatched (the app's own login page still renders 200),
 *  so the OIDC handshake must be driven directly (#1685, the #1559 case). */
async function probeOidcHost(deps: SsoVerifyDeps, run: SsoRun, host: string, cookie: string): Promise<void> {
  const { clientId, redirectPath } = OIDC_CLIENT_SUBDOMAINS[host];
  // The redirect_uri must be one the client is registered with (#sso-redirect-uri):
  // `https://<subdomain>.<publicDomain><redirectPath>`. Sending the auth-portal URL
  // here is what produced the false "secret mismatch" — Authelia rejects an
  // unregistered redirect_uri before any client-health check.
  const redirectUri = `https://${host}.${run.publicDomain}${redirectPath}`;
  const probe = await deps.probeOidcAuthorization(run.publicDomain, clientId, redirectUri, cookie);
  run.userDomains.push(classifyOidcAuthorization(`${host}.${run.publicDomain}`, clientId, probe));
}

/** The forward-auth-derived hosts (no backing template, like ollama #1685) to
 *  probe on this install: only those whose NPM proxy host actually carries
 *  `auth_request /authelia`. A host that exists but isn't forward-auth-gated,
 *  or doesn't exist, is silently skipped — never false-failed. */
async function forwardAuthDerivedHosts(deps: SsoVerifyDeps, run: SsoRun): Promise<string[]> {
  const out: string[] = [];
  for (const host of FORWARD_AUTH_DERIVED_SUBDOMAINS) {
    if (await deps.hostHasForwardAuth(`${host}.${run.publicDomain}`)) out.push(host);
  }
  return out;
}

/** Hit every user-facing domain (cookie + follow redirects) and every
 *  admin-only domain (cookie, no redirects), recording per-domain results.
 *
 *  Templated user apps split by auth model (#1685): an OIDC-backed app
 *  (vault/photos/books) gets the real OIDC-authorization handshake check;
 *  a forward-auth app (files/sync/home/music/caldav) gets the login→cookie→
 *  access check. Forward-auth-derived hosts (ollama) are added iff their NPM
 *  host actually carries `auth_request`. */
async function probeAllDomains(deps: SsoVerifyDeps, run: SsoRun, cookie: string): Promise<void> {
  for (const host of probeableUserSubdomains(run.installedTemplates)) {
    if (OIDC_CLIENT_SUBDOMAINS[host]) {
      await probeOidcHost(deps, run, host, cookie);
    } else {
      await probeForwardAuthHost(deps, run, host, cookie);
    }
  }
  for (const host of await forwardAuthDerivedHosts(deps, run)) {
    await probeForwardAuthHost(deps, run, host, cookie);
  }
  // Jellyfin (`media`) authenticates via its OWN LDAP-Auth plugin → LLDAP, NOT
  // Authelia — so the forward-auth/OIDC probes above never touch it. Verify it
  // end-to-end by actually logging the ephemeral user in. Gated on the `media`
  // template being installed (no false-fail on a box without Jellyfin).
  if (run.installedTemplates.media != null) {
    const probe = await deps.probeJellyfinLogin(run.ephemeralUser, run.password);
    run.userDomains.push(classifyJellyfinLogin(`media.${run.publicDomain}`, probe));
  }
  for (const host of ADMIN_ONLY_HOSTS) {
    const probe = await deps.probeAdminDecision(run.publicDomain, host, cookie);
    run.adminDomains.push(classifyAdminReject(`${host}.${run.publicDomain}`, probe));
  }
}

/** Guaranteed teardown + verdict — always deletes a created ephemeral user
 *  and computes the overall pass/fail. */
async function finishRun(deps: SsoVerifyDeps, run: SsoRun): Promise<SsoVerifyReport> {
  let cleanedUp = true;
  if (run.created) {
    const del = await deps.deleteUser(run.ephemeralUser);
    cleanedUp = del.ok;
    if (del.ok) {
      run.steps.push({ id: 'cleanup', status: 'pass', detail: `deleted ${run.ephemeralUser}` });
    } else {
      logger.warn('ssoVerify', `failed to delete ephemeral user ${run.ephemeralUser}: ${del.message}`);
      run.steps.push({ id: 'cleanup', status: 'fail', detail: `could not delete ${run.ephemeralUser}: ${del.message}` });
    }
  }
  // The admin-reject probes always run once we reach the domain phase, so a
  // non-empty adminDomains is the "we got far enough to judge" signal. An
  // install with no installed user apps (only auth+infra) legitimately probes
  // zero user domains — that is not a failure (#1591).
  const ranDomains = run.adminDomains.length > 0;
  // A setup-step failure (couldn't provision the test user) means we never
  // ran the real test (#1673): report "couldn't run", not "SSO broken".
  const couldNotRun = run.setupFailed;
  const ok = !couldNotRun
    && ranDomains
    && run.steps.every(s => s.status !== 'fail')
    && run.userDomains.every(d => d.status !== 'fail')
    && run.adminDomains.every(d => d.status !== 'fail');
  return { ok, couldNotRun: couldNotRun && !ok, cleanedUp, ephemeralUser: run.ephemeralUser, steps: run.steps, userDomains: run.userDomains, adminDomains: run.adminDomains };
}

/**
 * Run the full create→login→per-domain→admin-reject→delete SSO verification
 * and return a structured report. The ephemeral user is **always** deleted —
 * on the success path and via `finishRun` on any failure or thrown error.
 */
export async function verifySso(options: SsoVerifyOptions = {}): Promise<SsoVerifyReport> {
  const deps = buildDeps(options.node ?? 'Local', options.deps);
  const run: SsoRun = {
    publicDomain: '',
    ephemeralUser: makeEphemeralUsername(),
    password: randomBytes(18).toString('hex'), // 36 hex chars, shell-safe
    installedTemplates: {},
    steps: [],
    userDomains: [],
    adminDomains: [],
    created: false,
    setupFailed: false,
  };

  const cfg = await getConfig();
  const publicDomain = cfg.reverseProxy?.publicDomain;
  if (!publicDomain) {
    run.steps.push({ id: 'config', status: 'fail', detail: 'reverseProxy.publicDomain is not configured — SSO is not set up yet.' });
    return finishRun(deps, run);
  }
  if (!cfg.installedTemplates?.auth) {
    run.steps.push({ id: 'config', status: 'skip', detail: 'auth template not installed — nothing to verify.' });
    return finishRun(deps, run);
  }
  run.publicDomain = publicDomain;
  run.installedTemplates = cfg.installedTemplates ?? {};

  try {
    if (!(await provisionEphemeralUser(deps, run))) return finishRun(deps, run);

    const login = await deps.autheliaFirstFactor(publicDomain, run.ephemeralUser, run.password);
    run.steps.push({ id: 'authelia_firstfactor', status: login.ok ? 'pass' : 'fail', detail: login.detail });
    if (!login.ok || !login.cookie) return finishRun(deps, run);

    await probeAllDomains(deps, run, login.cookie);
    return finishRun(deps, run);
  } catch (e) {
    run.steps.push({ id: 'unexpected_error', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    return finishRun(deps, run);
  }
}
