import { NextResponse } from 'next/server';
import { login } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { hashPassword, isPasswordHash, verifyPassword } from '@/lib/auth/password';
import { checkRateLimit, recordFailure, clearAttempts, clientKeyFromHeaders } from '@/lib/auth/rateLimit';
import { isRequestSecure } from '@/lib/auth/requestSecurity';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import { reconcileLogin } from './reconcile';

// Pre-hashed sentinel used when the supplied username does not match. Verifying
// against this hash is intentionally indistinguishable in timing from verifying
// the real hash, so a remote attacker cannot probe usernames by clock.
let DUMMY_HASH: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy-password-for-timing-equalization');
  return DUMMY_HASH;
}

function userKey(username: string): string {
  return `user:${username.toLowerCase()}`;
}

// skipAuth: login is intentionally public — requiring a session to log
// in would be circular. Mirrors src/proxy.ts:PUBLIC_API_RULES.
export const POST = withApiHandler({ skipAuth: true }, async ({ request }) => {
  try {
    const clientKey = clientKeyFromHeaders(request.headers);
    const ipDecision = checkRateLimit(clientKey);
    if (!ipDecision.allowed) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(ipDecision.retryAfterSec ?? 60) } },
      );
    }

    const body = await request.json();
    const { username, password } = body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    // Per-username throttle: defends against credential stuffing across many
    // source IPs (botnets) by limiting attempts on a single account.
    const uKey = userKey(username);
    const userDecision = checkRateLimit(uKey);
    if (!userDecision.allowed) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(userDecision.retryAfterSec ?? 60) } },
      );
    }

    const config = await getConfig();
    const configHash = config.auth?.passwordHash;
    const configUsername = config.auth?.username || process.env.SERVICEBAY_USERNAME || 'admin';
    const bootstrapPassword = process.env.SERVICEBAY_PASSWORD;

    if (!configHash && !bootstrapPassword) {
      return NextResponse.json({
        error: 'Authentication not configured. Set SERVICEBAY_PASSWORD on first start, then change it in the UI.',
      }, { status: 503 });
    }

    if (configHash && !isPasswordHash(configHash)) {
      return NextResponse.json({
        error: 'Stored credential is not a valid hash. Re-run the onboarding flow or unset auth.passwordHash in config.json.',
      }, { status: 503 });
    }

    // Always run scrypt verify regardless of whether the username matched, so
    // a wrong-username response takes the same wall-clock time as a wrong-password
    // response. On a username miss we verify against a dummy hash and discard it.
    const usernameMatches = username === configUsername;

    let authenticated = false;
    let newStoredHash: string | undefined;
    if (usernameMatches) {
      // Reconcile the reinstall-over-persisted-data lockout: a stored hash from
      // a prior install must not shadow the fresh SERVICEBAY_PASSWORD that
      // sb-tui handed the operator (issue #1438). The stored hash is tried
      // first, so an operator-changed password is never overridden — the env
      // password only wins (and re-keys the stored hash) when the stored
      // credential rejects the request.
      const result = await reconcileLogin(
        { candidate: password, storedHash: configHash ?? null, bootstrapPassword: bootstrapPassword ?? null },
        { verifyPassword, hashPassword },
      );
      authenticated = result.authenticated;
      newStoredHash = result.newStoredHash;
    } else {
      await verifyPassword(password, await getDummyHash());
    }

    if (!authenticated) {
      recordFailure(clientKey);
      recordFailure(uKey);
      logger.warn('auth:login', 'failed login', { ip: clientKey, username });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (newStoredHash) {
      const { updateConfig } = await import('@/lib/config');
      await updateConfig({ auth: { username: configUsername, passwordHash: newStoredHash } });
    }

    clearAttempts(clientKey);
    clearAttempts(uKey);
    await login(username, isRequestSecure(request));
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('auth:login', 'login crash', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
