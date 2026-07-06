/**
 * AdGuard Home DNS-rewrite client. Manages the wildcard `*.<domain>`
 * → `<lan-ip>` rewrites that make LAN-domain mode work (#249, D19-PR4).
 *
 * Reaches AdGuard via its REST API at `<adminUrl>/control/rewrite/*`.
 * Auth is HTTP Basic with the admin password ServiceBay auto-generates
 * at install time (`config.templateSettings.ADGUARD_ADMIN_PASSWORD`,
 * inherited from the template's variables.json).
 *
 * Functions are idempotent — `ensureWildcardRewrite` adds the rule
 * if missing, updates the IP if the rule exists with a different
 * answer, no-ops when already correct. `removeWildcardRewrite` is
 * forgiving on "not present" cases. Designed to be called on every
 * boot (#266 self-IP auto-update) and on every public-domain switch.
 */

/** Abort any AdGuard admin API call that doesn't answer within ~8s so an
 *  unreachable/wedged AdGuard fails fast instead of hanging the whole
 *  wildcard-rewrite op (#2158). Matches the diagnose house pattern
 *  (`ssoVerify.ts`, `certExpiry.ts` all use `AbortSignal.timeout(...)`).
 *  Callers already degrade on rejection (`listRewrites` → `[]`,
 *  ensure/remove → `'failed'`), so the timeout surfaces as a clear
 *  degrade rather than an indefinite stall. */
const HTTP_TIMEOUT_MS = 8000;

const REWRITES_LIST = '/control/rewrite/list';
const REWRITES_ADD = '/control/rewrite/add';
const REWRITES_UPDATE = '/control/rewrite/update';
const REWRITES_DELETE = '/control/rewrite/delete';

export interface AdguardRewrite {
  domain: string;
  answer: string;
}

interface ClientOpts {
  adminUrl: string;
  username?: string;
  password?: string;
  /** Override the global fetch — used by tests. */
  fetchImpl?: typeof fetch;
}

function authHeader(opts: ClientOpts): string | undefined {
  if (!opts.username || !opts.password) return undefined;
  const token = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
  return `Basic ${token}`;
}

async function request(opts: ClientOpts, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = authHeader(opts);
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (auth) headers['Authorization'] = auth;
  return fetchImpl(`${opts.adminUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** Read all current rewrites from AdGuard. Returns empty array if the
 *  call fails (e.g. AdGuard down).
 *
 *  AdGuard's API: `GET /control/rewrite/list`. The mutating endpoints
 *  (add/update/delete) are POST. This function used to POST `list` too,
 *  which AdGuard treats as 405 — silently returning empty here.
 *  ensureWildcardRewrite still "worked" because it falls through to ADD
 *  when the list returns empty, but the diagnose probe (which trusts
 *  the list as ground truth) reported every entry as missing. */
export async function listRewrites(opts: ClientOpts): Promise<AdguardRewrite[]> {
  try {
    const res = await request(opts, REWRITES_LIST, undefined, 'GET');
    if (!res.ok) return [];
    const data = (await res.json()) as AdguardRewrite[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Make sure the `<wildcardDomain>` → `<targetIp>` rewrite is live.
 * `wildcardDomain` is typically `*.home.arpa` (or the user's chosen
 * LAN domain). `targetIp` is ServiceBay's LAN IP.
 *
 * Idempotent. Returns `'added' | 'updated' | 'unchanged' | 'failed'`
 * so callers can log the right message.
 */
export async function ensureWildcardRewrite(
  opts: ClientOpts,
  wildcardDomain: string,
  targetIp: string,
): Promise<'added' | 'updated' | 'unchanged' | 'failed'> {
  const existing = await listRewrites(opts);
  const match = existing.find(r => r.domain === wildcardDomain);
  if (match && match.answer === targetIp) {
    return 'unchanged';
  }
  if (match) {
    // AdGuard's `/rewrite/update` takes both the old and new entries.
    try {
      const res = await request(opts, REWRITES_UPDATE, {
        target: { domain: match.domain, answer: match.answer },
        update: { domain: wildcardDomain, answer: targetIp },
      });
      return res.ok ? 'updated' : 'failed';
    } catch {
      return 'failed';
    }
  }
  try {
    const res = await request(opts, REWRITES_ADD, { domain: wildcardDomain, answer: targetIp });
    return res.ok ? 'added' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Remove the wildcard rewrite for the given domain. Returns
 * `'removed' | 'absent' | 'failed'`. Used by the public→lan
 * downgrade path and by template uninstall (rare).
 */
export async function removeWildcardRewrite(
  opts: ClientOpts,
  wildcardDomain: string,
): Promise<'removed' | 'absent' | 'failed'> {
  const existing = await listRewrites(opts);
  const match = existing.find(r => r.domain === wildcardDomain);
  if (!match) return 'absent';
  try {
    const res = await request(opts, REWRITES_DELETE, { domain: match.domain, answer: match.answer });
    return res.ok ? 'removed' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Convenience — build the wildcard pattern for a given domain.
 * `home.arpa` → `*.home.arpa`. Centralizes the convention.
 */
export function wildcardForDomain(domain: string): string {
  return `*.${domain.replace(/^[*.]+/, '')}`;
}
