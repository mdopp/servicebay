import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/auth/session';

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/oidc',
  '/api/auth/lldap-url',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
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
