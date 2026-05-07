// Thin shim: keeps the original public surface (`login`, `decrypt`, etc.) for
// callers that already imported from '@/lib/auth'. Server-side modules that
// boot the custom server (server.ts, proxy.ts) should prefer importing
// from '@/lib/auth/session' directly to avoid pulling in `next/headers`.
import { cookies } from 'next/headers';
import { encryptSession } from './auth/session';

export {
  decrypt,
  getSessionFromCookieHeader,
  readSessionCookie,
} from './auth/session';

export async function login(username: string, secure: boolean) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  const session = await encryptSession({ user: username, expires });

  const cookieStore = await cookies();
  cookieStore.set('session', session, {
    expires,
    httpOnly: true,
    sameSite: 'lax',
    // `secure` is decided per-request by the caller via isRequestSecure().
    // Setting it unconditionally in production breaks plain-HTTP LAN installs:
    // browsers refuse to store Secure cookies that arrive over HTTP.
    secure,
    path: '/',
  });
}
