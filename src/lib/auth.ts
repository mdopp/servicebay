// Thin shim: keeps the original public surface (`login`, `decrypt`, etc.) for
// callers that already imported from '@/lib/auth'. Server-side modules that
// boot the custom server (server.ts, middleware.ts) should prefer importing
// from '@/lib/auth/session' directly to avoid pulling in `next/headers`.
import { cookies } from 'next/headers';
import { encryptSession } from './auth/session';

export {
  decrypt,
  getSessionFromCookieHeader,
  readSessionCookie,
} from './auth/session';

export async function login(username: string) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  const session = await encryptSession({ user: username, expires });

  const cookieStore = await cookies();
  cookieStore.set('session', session, { expires, httpOnly: true, sameSite: 'lax' });
}
