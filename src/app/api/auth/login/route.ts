import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { hashPassword, isPasswordHash, verifyPassword } from '@/lib/auth/password';
import { checkRateLimit, recordFailure, clearAttempts, clientKeyFromHeaders } from '@/lib/auth/rateLimit';

export async function POST(request: NextRequest) {
  try {
    const clientKey = clientKeyFromHeaders(request.headers);
    const decision = checkRateLimit(clientKey);
    if (!decision.allowed) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSec ?? 60) } },
      );
    }

    const body = await request.json();
    const { username, password } = body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const config = await getConfig();
    const configHash = config.auth?.passwordHash;
    const configUsername = config.auth?.username || process.env.SERVICEBAY_USERNAME || 'admin';

    // Bootstrap path: if SERVICEBAY_PASSWORD is set and no hash is stored yet,
    // accept it once and persist a hash on success. Plaintext is never compared
    // to plaintext at rest.
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

    if (username !== configUsername) {
      recordFailure(clientKey);
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    let ok = false;
    if (configHash) {
      ok = await verifyPassword(password, configHash);
    } else if (bootstrapPassword) {
      // Constant-time-ish equality via verifyPassword on a freshly-hashed bootstrap value.
      const tempHash = await hashPassword(bootstrapPassword);
      ok = await verifyPassword(password, tempHash);
      if (ok) {
        const { updateConfig } = await import('@/lib/config');
        await updateConfig({ auth: { username: configUsername, passwordHash: tempHash } });
      }
    }

    if (!ok) {
      recordFailure(clientKey);
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    clearAttempts(clientKey);
    await login(username);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
