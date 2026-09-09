// Runtime-agnostic session helpers. Importable from server.ts, proxy.ts,
// MCP, and Next.js route handlers. Crucially does NOT import `next/headers`,
// which would pull `next/dist/server/app-render/...` into the custom server's
// CJS load path and trip Next's AsyncLocalStorage invariant under tsx.
import { SignJWT, jwtVerify } from 'jose';
import type { ApiScope } from '@/lib/auth/apiScope';

export interface SessionPayload {
  user: string;
  expires: string | Date;
  /**
   * Scopes the caller holds. Cookie sessions and the internal token carry
   * all scopes (omitted == all, for back-compat); a named API token
   * (Bearer `sb_`) carries exactly the scopes minted into it. Set by
   * `requireSession` — see #1264.
   */
  scopes?: ApiScope[];
  /**
   * Set when this session was minted from a named API token via the
   * token→session bridge (`POST /api/auth/session-from-token`). Holds the
   * source token's id so `requireSession` can re-check the token is still live
   * on every request — revoking (or expiring) the token instantly kills the
   * bridged session, the same cascading-revocation that protects token chains
   * (#2047). Absent on password-login / internal sessions.
   */
  viaToken?: string;
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

/**
 * Hard ceiling on a session cookie's lifetime. A payload that computes a
 * SHORTER `expires` (the token→session bridge caps at 1h, and never past the
 * source token) gets that shorter one — see `encryptSession` (#2931).
 */
export const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds-since-epoch of a payload's computed `expires`, or null when it
 * carries none (or an unparseable one). A session without `expires` is NOT
 * treated as expired — the JWT `exp` claim remains its only bound.
 */
function expiresAtMs(expires: unknown): number | null {
  if (expires instanceof Date) {
    const ms = expires.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof expires === 'number') return Number.isFinite(expires) ? expires : null;
  if (typeof expires === 'string') {
    const ms = Date.parse(expires);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Sign a session payload.
 *
 * The JWT `exp` claim is `min(payload.expires, now + 24h)`, NOT a flat 24h
 * (#2931). Before this, `POST /api/auth/session-from-token` computed
 * `min(now+1h, token.expiresAt)`, put it in the payload and the cookie
 * attribute — and nothing read it back, so `jwtVerify` happily accepted the
 * cookie for a full day. A cookie attribute is a client-side courtesy; the
 * signed claim is the only bound an attacker cannot edit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function encryptSession(payload: any) {
  const cap = Date.now() + MAX_SESSION_LIFETIME_MS;
  const computed = expiresAtMs(payload?.expires);
  const effective = computed === null ? cap : Math.min(computed, cap);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    // Seconds since epoch; round UP so a sub-second TTL is not truncated to
    // "already expired".
    .setExpirationTime(Math.ceil(effective / 1000))
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

/**
 * Is this decoded session still usable *right now*?
 *
 * Two questions the signature alone cannot answer (#2931):
 *  1. **Computed expiry.** `expires` is the value the minting route computed
 *     (the bridge: `min(now+1h, token.expiresAt)`). `encryptSession` binds it
 *     into `exp`, but a cookie signed before that fix — or any payload whose
 *     `expires` is shorter than its `exp` — must still be refused here.
 *  2. **Source-token liveness.** A session minted by the token→session bridge
 *     carries `viaToken`. Revoking or expiring that token kills the session
 *     immediately (#2047 cascading revocation). This lives HERE, at the single
 *     cookie→session chokepoint, and not in one caller: before #2931 only
 *     `requireSession` (`/api/*`) asked, so the very same cookie kept driving
 *     MCP tools over `/mcp`, kept its Socket.IO connection, and kept passing
 *     the proxy gate for up to 24h after the operator pressed Revoke.
 *
 * A password-login / internal session carries no `viaToken` and never touches
 * the token store.
 *
 * Deliberately module-private: `getSessionFromCookieHeader` below is the only
 * caller, because it is the only place a cookie becomes a principal. A surface
 * that wants to call this directly is a surface that read the cookie itself.
 */
async function sessionIsLive(session: SessionPayload): Promise<boolean> {
  const expiresAt = expiresAtMs(session.expires);
  if (expiresAt !== null && expiresAt <= Date.now()) return false;
  if (session.viaToken) {
    const { tokenIsLive } = await import('@/lib/auth/apiTokens');
    if (!(await tokenIsLive(session.viaToken))) return false;
  }
  return true;
}

/**
 * Validate a raw cookie header and return the decrypted session payload, or null.
 *
 * **This is the only supported way to turn a session cookie into a principal.**
 * Every surface that accepts the cookie — `/api/*` via `requireSession`, `/mcp`
 * and Socket.IO in the custom server, `/api/auth/me`, and the `proxy.ts` gate —
 * goes through here, so the liveness rules in `sessionIsLive` apply once
 * instead of per caller. Reading the cookie and calling `decrypt` yourself
 * bypasses revocation; `tests/backend/session_cookie_liveness_gate.test.ts`
 * fails the build if a new surface does.
 */
export async function getSessionFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<SessionPayload | null> {
  const token = readSessionCookie(cookieHeader);
  if (!token) return null;
  const payload = await decrypt(token);
  if (!payload || typeof payload.user !== 'string') return null;
  const session = payload as SessionPayload;
  if (!(await sessionIsLive(session))) return null;
  return session;
}
