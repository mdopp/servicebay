import { NextResponse } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * Generate a fresh RSA private key in PKCS#8 PEM format. Used by the install
 * wizard for templates that need a real RSA key (e.g. Authelia's OIDC JWKS —
 * Authelia 4.39+ no longer auto-generates one and refuses to start without
 * a valid `key` / `key_path`).
 *
 * Defaults to 2048-bit RS256-compatible keys, sufficient for OIDC signing.
 */
export async function GET() {
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return NextResponse.json({ pem: privateKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'key generation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
