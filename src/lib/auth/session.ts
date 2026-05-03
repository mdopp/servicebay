// Runtime-agnostic session helpers. Importable from server.ts, middleware.ts,
// MCP, and Next.js route handlers. Crucially does NOT import `next/headers`,
// which would pull `next/dist/server/app-render/...` into the custom server's
// CJS load path and trip Next's AsyncLocalStorage invariant under tsx.
import { SignJWT, jwtVerify } from 'jose';

export interface SessionPayload {
  user: string;
  expires: string | Date;
}

/**
 * Validate AUTH_SECRET. Throws with a clear message if missing or too short.
 * Called at server startup (server.ts) and lazily by encrypt/decrypt so that
 * `next build` (which imports route modules but never signs/verifies tokens)
 * does not require the secret to be set in the build environment.
 */
export function assertAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET environment variable is required and must be at least 32 characters. ' +
      'Generate one with: openssl rand -hex 32',
    );
  }
  return secret;
}

let cachedKey: Uint8Array | null = null;
function getKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  cachedKey = new TextEncoder().encode(assertAuthSecret());
  return cachedKey;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function encryptSession(payload: any) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getKey());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function decrypt(input: string): Promise<any> {
  try {
    const { payload } = await jwtVerify(input, getKey(), {
      algorithms: ['HS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

/** Parse a raw `Cookie:` header and return the value of `session`, or null. */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== 'session') continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Validate a raw cookie header and return the decrypted session payload, or null. */
export async function getSessionFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<SessionPayload | null> {
  const token = readSessionCookie(cookieHeader);
  if (!token) return null;
  const payload = await decrypt(token);
  if (!payload || typeof payload.user !== 'string') return null;
  return payload as SessionPayload;
}
