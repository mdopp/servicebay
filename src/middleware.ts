import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decrypt } from '@/lib/auth';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.svg'
  ) {
    return NextResponse.next();
  }

  // 1. Check for Proxy Auth (if enabled)
  if (process.env.AUTH_TRUST_PROXY === 'true') {
    const remoteUser = request.headers.get('Remote-User') || request.headers.get('X-Forwarded-User');
    if (remoteUser) {
      return NextResponse.next();
    }
  }

  // 2. Check for Session Cookie
  const cookie = request.cookies.get('session')?.value;
  if (cookie) {
    const session = await decrypt(cookie);
    if (session && session.expires && new Date(session.expires) > new Date()) {
      return NextResponse.next();
    }
  }

  // Redirect to login
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (except api/auth)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
