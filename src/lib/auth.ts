import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

// Use a fixed fallback key for development/unconfigured environments to ensure
// consistency between Edge Runtime (Middleware) and Node Runtime (API).
// In production, AUTH_SECRET should always be set.
const SECRET_KEY = process.env.AUTH_SECRET || 'servicebay-insecure-fallback-secret-key-change-me';
const key = new TextEncoder().encode(SECRET_KEY);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function encrypt(payload: any) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function decrypt(input: string): Promise<any> {
  try {
    const { payload } = await jwtVerify(input, key, {
      algorithms: ['HS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

export async function login(username: string) {
  // Create the session
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  const session = await encrypt({ user: username, expires });

  // Save the session in a cookie
  const cookieStore = await cookies();
  cookieStore.set('session', session, { expires, httpOnly: true, sameSite: 'lax' });
}
