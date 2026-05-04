import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/auth/session';

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/oidc',
  '/api/auth/lldap-url',
];

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith('/api/')) return NextResponse.next();
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
