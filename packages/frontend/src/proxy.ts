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
};

const PUBLIC_API_RULES: PublicApiRule[] = [
  { prefix: '/api/auth/login' },
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
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isPublicApi(pathname: string, method: string): boolean {
  return PUBLIC_API_RULES.some(rule => {
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

  // Apex / www host → portal. Rewrite (not redirect) so the URL bar
  // stays at home.arpa / www.home.arpa per the v2 design call.
  // Apply to every path on these hosts so URL guessing (home.arpa/services
  // etc.) can't escape into the admin surface.
  if (!pathname.startsWith('/api/')) {
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

  if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden: cross-site request' }, { status: 403 });
  }

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
    '/((?!_next/static|_next/image|favicon|icon\\.svg|.*\\.(?:png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)).*)',
  ],
};
