import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/auth/session';
import { getInternalApiToken } from '@/lib/auth/internalToken';

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/oidc',
  '/api/auth/lldap-url',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith('/api/')) return NextResponse.next();

  // Internal calls (post-deploy scripts on the agent host) bypass
  // both CSRF and session checks — the token authenticates them.
  if (isInternalCall(request)) return NextResponse.next();

  if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden: cross-site request' }, { status: 403 });
  }

  if (isPublicApi(pathname)) return NextResponse.next();

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
  matcher: ['/api/:path*'],
};
