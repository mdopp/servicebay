import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/auth/session';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { getConfig } from '@/lib/config';
import { getActiveDomain } from '@/lib/mode';

/**
 * Routes that bypass the session-cookie check. Each rule can pin
 * which HTTP methods are public — without `methods`, every method
 * is allowed. A rule with `pattern` is a regex match against the
 * full pathname; otherwise `prefix` matches the path exactly or as
 * the start of a deeper segment.
 *
 * `/api/system/access-requests` POST is public so the anonymous
 * family-portal visitor can submit a request without a session;
 * GET/PATCH/DELETE on the same prefix stay admin-only (#242
 * follow-up). The `[id]/status` pattern below is the one GET
 * exception — the visitor needs to poll their own request status
 * to render the pending / approved CTA (#1001), and the response
 * carries only first-name + status + the (already-public) auth URL.
 */
type PublicApiRule = {
  /** Match by prefix — `pathname === prefix` OR starts with `prefix + '/'`. */
  prefix?: string;
  /** Match by full-pathname regex. Mutually exclusive with prefix. */
  pattern?: RegExp;
  methods?: ReadonlySet<string>;
  /**
   * #2281 — also skip the same-origin CSRF check for this route. Normal public
   * rules still enforce CSRF (they only skip the session cookie); set this ONLY
   * for a route whose legitimate caller is a cross-origin, no-Origin client (a
   * companion app / server-to-server POST) AND whose OWN handler is fail-closed
   * on a self-supplied credential. `/napi/pair/redeem` qualifies: the pairing
   * CODE is the credential, it is single-use + constant-time + rate-limited, and
   * it mints only a READ-scoped token — so there is nothing for a forged
   * cross-site POST to abuse. Do NOT set this on a header-trust route
   * (`/napi/pair`): that one must stay CSRF-gated so a direct `:5888` forgery
   * 403s (its trust flows only from the NPM-injected internal token, #2278).
   */
  csrfExempt?: boolean;
};

const PUBLIC_API_RULES: PublicApiRule[] = [
  { prefix: '/api/auth/login' },
  // Logout just clears the session cookie — public so a user holding a stale
  // cookie (e.g. after an AUTH_SECRET rotation) can still drop it instead of
  // being gated out of logging out.
  { prefix: '/api/auth/logout', methods: new Set(['POST']) },
  { prefix: '/api/auth/oidc' },
  { prefix: '/api/auth/lldap-url' },
  { prefix: '/api/system/access-requests', methods: new Set(['POST']) },
  // #1001 — GET status of one access request by id, public-readable
  // because the submitter has no session yet. Tight regex anchors the
  // UUID-shaped id segment so deeper admin paths under [id]/ (PATCH /
  // DELETE / /welcome / /approve) stay session-gated.
  {
    pattern: /^\/api\/system\/access-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/status$/i,
    methods: new Set(['GET']),
  },
  // Family-portal setup assets (#242). GET-only — the route handler
  // also gates by mode (LAN-only) and validates the service +
  // asset-kind path params before producing anything.
  { prefix: '/api/portal/asset', methods: new Set(['GET']) },
  // Install-progress polling endpoint (#663 — S1). GET-only; the
  // route handler requires a valid `jobId` query parameter (uuidv4
  // from `createJob`). Public so that the install-progress overlay
  // keeps updating when the session cookie is invalidated mid-install
  // by a wipe-secrets clean install. Returns sanitised progress only
  // — no `input.variables`, no credentials manifest.
  { prefix: '/api/install/progress', methods: new Set(['GET']) },
  // BasicSync APK download-redirect (file-share user guide → "install the
  // Android Syncthing client"). GET-only; resolves the latest release asset
  // for the requested ABI and 302s to a public GitHub URL. Public because
  // the portal user guide that links it is family-facing — no secrets.
  { prefix: '/api/system/downloads/basicsync', methods: new Set(['GET']) },
  // #2281 — the ONE public device-pairing redeem surface. A companion app
  // POSTs `{ code }` here (cross-origin, no Origin, no Bearer) to trade a
  // pairing code for a read-scoped token. It is `csrfExempt` because its
  // legitimate caller has no browser Origin; the handler itself is fail-closed
  // (single-use + constant-time + rate-limited code → read-only token), so the
  // pairing CODE is the whole credential. This mirrors the route's own comment
  // ("When `/napi/*` moves behind proxy.ts, add a PUBLIC_API_RULES entry").
  { prefix: '/napi/pair/redeem', methods: new Set(['POST']), csrfExempt: true },
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchPublicRule(pathname: string, method: string): PublicApiRule | undefined {
  return PUBLIC_API_RULES.find(rule => {
    let matches = false;
    if (rule.prefix !== undefined) {
      matches = pathname === rule.prefix || pathname.startsWith(rule.prefix + '/');
    } else if (rule.pattern !== undefined) {
      matches = rule.pattern.test(pathname);
    }
    if (!matches) return false;
    return !rule.methods || rule.methods.has(method);
  });
}

function isPublicApi(pathname: string, method: string): boolean {
  return matchPublicRule(pathname, method) !== undefined;
}

/** #2281 — a public route flagged to also skip the same-origin CSRF check
 *  (its legitimate caller has no browser Origin; see {@link PublicApiRule.csrfExempt}). */
function isCsrfExempt(pathname: string, method: string): boolean {
  return matchPublicRule(pathname, method)?.csrfExempt === true;
}

/** True when a state-changing request must be rejected as cross-site: an unsafe
 *  method that is neither same-origin nor a {@link isCsrfExempt} public route. */
function failsCsrf(request: NextRequest): boolean {
  return (
    !SAFE_METHODS.has(request.method) &&
    !isSameOrigin(request) &&
    !isCsrfExempt(request.nextUrl.pathname, request.method)
  );
}

// Server-to-server calls from ServiceBay's own post-deploy scripts on
// the agent host. The script reads SB_API_TOKEN from its env file and
// sends it as `X-SB-Internal-Token`. Token is derived from AUTH_SECRET
// so it survives restarts without extra config plumbing. Without this,
// every callback (LLDAP probe, credentials persistence, …) from the
// post-deploy scripts hit the CSRF check (no Origin header from
// urllib) and got 403, which the wizard surfaced as e.g. "LLDAP did
// not respond in time" while LLDAP was actually up in <1 s.
function isInternalCall(request: NextRequest): boolean {
  const presented = request.headers.get('x-sb-internal-token');
  if (!presented) return false;
  const expected = getInternalApiToken();
  if (presented.length !== expected.length) return false;
  // Constant-time compare via Buffer to avoid timing leaks.
  try {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// Named API token presented and valid? Validates the `Authorization: Bearer
// sb_…` header so a token-bearing request (CLI / TUI / scripts) can bypass the
// cookie + CSRF gates. Returns false for an absent/malformed/invalid token so
// the request falls through to the normal session checks. Scope is NOT checked
// here — that's the per-route handler's job (`requireSession({ tokenScope })`).
async function isValidBearerToken(request: NextRequest): Promise<boolean> {
  const authz = request.headers.get('authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;
  if (!bearer) return false;
  try {
    const { verifyToken } = await import('@/lib/auth/apiTokens');
    return (await verifyToken(bearer)) !== null;
  } catch {
    return false;
  }
}

// Same-origin CSRF check: for state-changing methods, the request's Origin
// (or Referer fallback) must match the Host the browser saw. Behind NPM the
// Host header is the public hostname and the browser's Origin uses that same
// hostname → match. Cross-site form posts carry the attacker's origin →
// mismatch → reject. No Origin AND no Referer on an unsafe method → reject.
function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get('host');
  if (!host) return false;
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    try { return new URL(originHeader).host === host; } catch { return false; }
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return false;
}

/**
 * Detect whether the incoming request is for the family-portal apex
 * (e.g. `home.arpa` or `www.home.arpa`) or one of the admin
 * hostnames. Apex/www hosts get their requests rewritten to /portal
 * regardless of path so a family member typing just the domain
 * lands on the card grid (#242 follow-up).
 *
 * Reads `getActiveDomain(config)` per request — file IO but cached
 * by the OS, and config.json is small. If the read fails (e.g.
 * config not yet initialized) we just pass through, deferring to
 * the page-level handlers.
 */
async function isPortalApexHost(host: string): Promise<boolean> {
  if (!host) return false;
  // Strip port if present (Host header may include :port for non-80/443).
  const bareHost = host.split(':')[0].toLowerCase();
  let activeDomain: string;
  try {
    const config = await getConfig();
    activeDomain = getActiveDomain(config).toLowerCase();
  } catch {
    return false;
  }
  if (!activeDomain) return false;
  return bareHost === activeDomain || bareHost === `www.${activeDomain}`;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') ?? '';

  // #2281 — `/napi/*` (the native-companion API twins) run through the SAME
  // internal-token / Bearer / CSRF gate as `/api/*`, because `/napi/pair` is a
  // `skipAuth:true` forward-auth-header-trust route: a direct `:5888` POST forging
  // `Remote-User`/`Remote-Groups:admins` without an Origin (and without the
  // NPM-injected internal token, #2278) MUST be 403'd, or a LAN attacker mints a
  // pairing code. Before this, the `!startsWith('/api/')` short-circuit let every
  // `/napi/*` request straight through, CSRF-unchecked. These routes never rely on
  // a session cookie (they are token- or forward-auth-gated at the handler via
  // `skipAuth`/`tokenScope`), so we run the gate but fall through to the handler
  // rather than the cookie check — see the isNapi branch below.
  const isNapi = pathname.startsWith('/napi/');
  if (!pathname.startsWith('/api/') && !isNapi) {
    // Apex / www host → portal. Rewrite (not redirect) so the URL bar
    // stays at home.arpa / www.home.arpa per the v2 design call.
    // Apply to every path on these hosts so URL guessing (home.arpa/services
    // etc.) can't escape into the admin surface.
    if (await isPortalApexHost(host) && !pathname.startsWith('/portal')) {
      const rewritten = request.nextUrl.clone();
      rewritten.pathname = '/portal';
      return NextResponse.rewrite(rewritten);
    }
    return NextResponse.next();
  }

  // Internal calls (post-deploy scripts on the agent host) bypass
  // both CSRF and session checks — the token authenticates them.
  if (isInternalCall(request)) return NextResponse.next();

  // Named API token (`Authorization: Bearer sb_…`, #1265/#1275). A *valid*
  // token bypasses the CSRF + cookie gates exactly like the internal token —
  // a token-bearing CLI/TUI has no browser Origin or session cookie. Per-route
  // scope enforcement still happens at the handler (`requireSession` with the
  // route's `tokenScope`); the proxy only decides reachability. We MUST verify
  // the token here: passing an unvalidated `Bearer` header through would let an
  // attacker append `Bearer x` to a cookie'd victim's request to skip the CSRF
  // check. An invalid/absent Bearer just falls through to the normal checks.
  if (await isValidBearerToken(request)) return NextResponse.next();

  if (failsCsrf(request)) {
    return NextResponse.json({ error: 'Forbidden: cross-site request' }, { status: 403 });
  }

  // #2281 — `/napi/*` routes carry their own auth at the handler (`skipAuth` +
  // forward-auth headers, or `tokenScope` Bearer) and never use a session
  // cookie. Having passed the internal-token/Bearer/CSRF gate above, let them
  // reach the handler — do NOT fall into the admin session-cookie check below
  // (which would 401 every token/forward-auth companion request).
  if (isNapi) return NextResponse.next();

  if (isPublicApi(pathname, request.method)) return NextResponse.next();

  const token = request.cookies.get('session')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await decrypt(token);
  if (!session || typeof session.user !== 'string') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  // `/api/*` keeps the existing auth gating; `/((?!_next/static|_next/image|favicon|icon\\.svg).*)` matches
  // every page request so the apex/www → /portal rewrite can fire.
  // Static assets are excluded so they short-circuit without touching
  // the middleware.
  matcher: [
    '/api/:path*',
    // #2281 — the native-companion API twins must also pass through the gate so
    // the CSRF/internal-token check applies to `/napi/pair` (was previously
    // short-circuited by the non-`/api/` bypass, letting a LAN header-forgery
    // POST straight through).
    '/napi/:path*',
    '/((?!_next/static|_next/image|favicon|icon\\.svg|.*\\.(?:png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)).*)',
  ],
};
