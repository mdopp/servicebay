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
import {
  createLldapUser,
  addUserToLldapGroup,
  deleteLldapUser,
  listLldapGroups,
} from '@/lib/lldap/client';

const AUTHELIA_DEFAULT_PORT = 9091;
const LLDAP_CONTAINER = 'auth-lldap';
const HTTP_TIMEOUT_MS = 8000;
const SET_PASSWORD_TIMEOUT_MS = 15_000;

/**
 * User-facing service subdomain → optional content signature. An empty
 * signature means "2xx/3xx is enough"; a non-empty one is grepped in the
 * body so the check also catches "200 with the wrong content" (a half-broken
 * proxy). Kept in sync with the smoke test's USER_APPS map; ollama is
 * intentionally absent (no auth, opt-in NPM host only — see #1180).
 */
export const USER_APP_SIGNATURES: Readonly<Record<string, string>> = {
  vault: 'Vaultwarden Web',
  photos: '',
  music: '',
  books: 'Audiobookshelf',
  home: '',
  files: '',
  sync: '',
  caldav: '',
  hermes: 'Hermes Agent',
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
    const cfg = await getConfig();
    const lldapUrl = cfg.lldap?.url ?? 'http://localhost:17170';
    const agent = await agentManager.ensureAgent(node);
    const res = await agent.sendCommand('exec', {
      command:
        `podman exec ${LLDAP_CONTAINER} /app/lldap_set_password ` +
        `-u ${userId} -p '${password}' --base-url ${lldapUrl} 2>&1`,
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

function buildDeps(node: string, overrides?: Partial<SsoVerifyDeps>): SsoVerifyDeps {
  return {
    createUser: createLldapUser,
    addToGroup: addUserToLldapGroup,
    deleteUser: deleteLldapUser,
    listGroups: listLldapGroups,
    setPassword: realSetPassword(node),
    autheliaFirstFactor: realAutheliaFirstFactor,
    probeDomain: realProbeDomain,
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
  steps: SsoStepResult[];
  userDomains: SsoDomainResult[];
  adminDomains: SsoDomainResult[];
  created: boolean;
}

/** Create the ephemeral user, set its password, and join `family`. Returns
 *  false on the first failing step (caller then funnels through cleanup). */
async function provisionEphemeralUser(deps: SsoVerifyDeps, run: SsoRun): Promise<boolean> {
  const groups = await deps.listGroups();
  if (!groups.ok) {
    run.steps.push({ id: 'list_groups', status: 'fail', detail: `could not read LLDAP groups: ${groups.message}` });
    return false;
  }
  const family = groups.groups.find(g => g.displayName === 'family');
  if (!family) {
    run.steps.push({ id: 'family_group', status: 'fail', detail: "no 'family' group in LLDAP — Authelia's user rules expect it." });
    return false;
  }
  run.steps.push({ id: 'family_group', status: 'pass', detail: `'family' group present (id=${family.id})` });

  const create = await deps.createUser({ id: run.ephemeralUser, email: `${run.ephemeralUser}@${run.publicDomain}`, displayName: 'SSO Verify (ephemeral)' });
  if (!create.ok) {
    run.steps.push({ id: 'create_user', status: 'fail', detail: `createUser failed: ${create.message}` });
    return false;
  }
  run.created = true;
  run.steps.push({ id: 'create_user', status: 'pass', detail: `created ${run.ephemeralUser}` });

  const pw = await deps.setPassword(run.ephemeralUser, run.password);
  run.steps.push({ id: 'set_password', status: pw.ok ? 'pass' : 'fail', detail: pw.ok ? 'password set via lldap_set_password' : pw.message });
  if (!pw.ok) return false;

  const grp = await deps.addToGroup(run.ephemeralUser, family.id);
  run.steps.push({ id: 'join_family', status: grp.ok ? 'pass' : 'fail', detail: grp.ok ? 'joined family group' : `addUserToGroup failed: ${grp.message}` });
  return grp.ok;
}

/** Hit every user-facing domain (cookie + follow redirects) and every
 *  admin-only domain (cookie, no redirects), recording per-domain results. */
async function probeAllDomains(deps: SsoVerifyDeps, run: SsoRun, cookie: string): Promise<void> {
  for (const [host, signature] of Object.entries(USER_APP_SIGNATURES)) {
    const probe = await deps.probeDomain(run.publicDomain, host, cookie, true);
    run.userDomains.push(classifyUserDomain(`${host}.${run.publicDomain}`, signature, probe));
  }
  for (const host of ADMIN_ONLY_HOSTS) {
    const probe = await deps.probeDomain(run.publicDomain, host, cookie, false);
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
  const ranDomains = run.userDomains.length > 0 && run.adminDomains.length > 0;
  const ok = ranDomains
    && run.steps.every(s => s.status !== 'fail')
    && run.userDomains.every(d => d.status !== 'fail')
    && run.adminDomains.every(d => d.status !== 'fail');
  return { ok, cleanedUp, ephemeralUser: run.ephemeralUser, steps: run.steps, userDomains: run.userDomains, adminDomains: run.adminDomains };
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
    steps: [],
    userDomains: [],
    adminDomains: [],
    created: false,
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
