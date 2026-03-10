import { NextRequest, NextResponse } from 'next/server';
import { getConfig, getOidcCallbackUrl } from '@/lib/config';
import { login } from '@/lib/auth';
import { jwtVerify, createRemoteJWKSet } from 'jose';

export async function GET(request: NextRequest) {
  try {
    const config = await getConfig();

    if (!config.oidc?.enabled) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    const { issuer, clientId, clientSecret, allowedGroups } = config.oidc;
    const { searchParams } = new URL(request.url);

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      console.error('OIDC error:', error, searchParams.get('error_description'));
      return NextResponse.redirect(new URL('/login?error=oidc_denied', request.url));
    }

    if (!code || !state) {
      return NextResponse.redirect(new URL('/login?error=oidc_invalid', request.url));
    }

    // Verify state matches
    const storedState = request.cookies.get('oidc_state')?.value;
    if (!storedState || storedState !== state) {
      return NextResponse.redirect(new URL('/login?error=oidc_state', request.url));
    }

    // Exchange code for tokens
    const callbackUrl = getOidcCallbackUrl(config);
    const tokenResponse = await fetch(`${issuer}/api/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('OIDC token exchange failed:', await tokenResponse.text());
      return NextResponse.redirect(new URL('/login?error=oidc_token', request.url));
    }

    const tokens = await tokenResponse.json();

    // Verify and decode ID token
    const jwksUrl = new URL(`${issuer}/jwks.json`);
    const JWKS = createRemoteJWKSet(jwksUrl);
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer,
      audience: clientId,
    });

    const username = (payload.preferred_username as string) || (payload.sub as string);
    const groups = (payload.groups as string[]) || [];

    // Check group membership if allowedGroups is configured
    if (allowedGroups && allowedGroups.length > 0) {
      const hasAccess = groups.some(g => allowedGroups.includes(g));
      if (!hasAccess) {
        return NextResponse.redirect(new URL('/login?error=oidc_forbidden', request.url));
      }
    }

    // Create session using existing login function
    await login(username);

    // Clear the state cookie and redirect to services
    const response = NextResponse.redirect(new URL('/services', request.url));
    response.cookies.delete('oidc_state');
    return response;
  } catch (error) {
    console.error('OIDC callback error:', error);
    return NextResponse.redirect(new URL('/login?error=oidc_error', request.url));
  }
}
