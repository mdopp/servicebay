import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getOidcCallbackUrl } from '@/lib/config';
import { logger } from '@/lib/logger';
import crypto from 'crypto';

export async function GET() {
  try {
    const config = await getConfig();

    if (!config.oidc?.enabled) {
      return NextResponse.json({ error: 'OIDC not configured' }, { status: 404 });
    }

    const { issuer, clientId } = config.oidc;

    // Generate state parameter for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Build authorization URL
    const authUrl = new URL(`${issuer}/api/oidc/authorization`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email groups');
    authUrl.searchParams.set('redirect_uri', getOidcCallbackUrl(config));
    authUrl.searchParams.set('state', state);

    const response = NextResponse.redirect(authUrl.toString());
    // Store state in a short-lived cookie for verification.
    // sameSite must stay 'lax' so the cookie survives the issuer's top-level
    // GET redirect back to /api/auth/oidc/callback.
    response.cookies.set('oidc_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error) {
    logger.error('api:auth:oidc', 'OIDC redirect error', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
