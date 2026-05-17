import { NextRequest, NextResponse } from 'next/server';
import { getConfig, getOidcCallbackUrl } from '@/lib/config';
import { login } from '@/lib/auth';
import { isRequestSecure } from '@/lib/auth/requestSecurity';
import { assertValidOidcIssuer } from '@/lib/auth/oidcIssuer';
import { logger } from '@/lib/logger';
import { jwtVerify, createRemoteJWKSet } from 'jose';

export async function GET(request: NextRequest) {
  try {
    const config = await getConfig();

    if (!config.oidc?.enabled) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    const { issuer, clientId, clientSecret, allowedGroups } = config.oidc;
    // SSRF / scheme guard (#577). Refuse to fetch from loopback /
    // link-local / non-https issuers — never legitimate, sometimes
    // attacker-controlled if config write access is compromised.
    try {
      assertValidOidcIssuer(issuer);
    } catch (e) {
      logger.error('api:auth:oidc:callback', 'OIDC issuer rejected:', e instanceof Error ? e.message : String(e));
      return NextResponse.redirect(new URL('/login?error=oidc_config', request.url));
    }
    const { searchParams } = new URL(request.url);

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      logger.error('api:auth:oidc:callback', 'OIDC error', error, searchParams.get('error_description'));
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
      // Log only the status code, NOT the response body — the body
      // could contain attacker-controlled content if the issuer URL
      // has been tampered with, turning the log surface into an SSRF
      // exfiltration channel (#577). Operators debugging real OIDC
      // failures can read the upstream IdP's logs directly.
      logger.error('api:auth:oidc:callback', `OIDC token exchange failed: HTTP ${tokenResponse.status}`);
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
    await login(username, isRequestSecure(request));

    // Clear the state cookie and redirect to services
    const response = NextResponse.redirect(new URL('/services', request.url));
    response.cookies.delete('oidc_state');
    return response;
  } catch (error) {
    logger.error('api:auth:oidc:callback', 'OIDC callback error', error);
    return NextResponse.redirect(new URL('/login?error=oidc_error', request.url));
  }
}
