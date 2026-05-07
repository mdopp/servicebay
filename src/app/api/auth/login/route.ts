import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { hashPassword, isPasswordHash, verifyPassword } from '@/lib/auth/password';
import { checkRateLimit, recordFailure, clearAttempts, clientKeyFromHeaders } from '@/lib/auth/rateLimit';
import { logger } from '@/lib/logger';

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

export async function POST(request: NextRequest) {
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
    // response. We discard the verify result if the username didn't match.
    const usernameMatches = username === configUsername;

    let referenceHash: string;
    let tempBootstrapHash: string | null = null;
    if (usernameMatches && configHash) {
      referenceHash = configHash;
    } else if (usernameMatches && bootstrapPassword) {
      tempBootstrapHash = await hashPassword(bootstrapPassword);
      referenceHash = tempBootstrapHash;
    } else {
      referenceHash = await getDummyHash();
    }

    const verifyOk = await verifyPassword(password, referenceHash);
    const ok = usernameMatches && verifyOk;

    if (!ok) {
      recordFailure(clientKey);
      recordFailure(uKey);
      logger.warn('auth:login', 'failed login', { ip: clientKey, username });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (tempBootstrapHash) {
      const { updateConfig } = await import('@/lib/config');
      await updateConfig({ auth: { username: configUsername, passwordHash: tempBootstrapHash } });
    }

    clearAttempts(clientKey);
    clearAttempts(uKey);
    await login(username);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('auth:login', 'login crash', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
