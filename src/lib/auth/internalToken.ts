import crypto from 'node:crypto';

/**
 * Token shared between the ServiceBay process and its own post-deploy
 * scripts. Derived (not equal) from AUTH_SECRET so it survives restarts
 * without needing extra config plumbing, but compromise of this token
 * alone doesn't reveal the session-signing secret.
 *
 * Used by:
 *   - ServiceManager.runPostDeployScript writes it into each post-
 *     deploy script's env file as SB_API_TOKEN.
 *   - The shipped post-deploy.py scripts attach it as the
 *     `X-SB-Internal-Token` header on every callback into ServiceBay
 *     (e.g. /api/system/lldap/probe, /api/system/lldap/credentials).
 *   - proxy.ts validates the header before applying the CSRF + session
 *     checks, so server-to-server calls from the agent host can hit
 *     the API without a browser session cookie.
 *
 * Read AUTH_SECRET lazily so test environments that import this module
 * before setting AUTH_SECRET don't crash at import time.
 */
let cached: string | null = null;

export function getInternalApiToken(): string {
    if (cached) return cached;
    const secret = process.env.AUTH_SECRET ?? '';
    if (!secret) {
        // Fall back to a per-process random token. Without AUTH_SECRET
        // the install isn't supportable anyway, but at least don't
        // crash — yield a random value and let the rest of the app
        // surface the underlying configuration problem.
        cached = crypto.randomBytes(32).toString('hex');
        return cached;
    }
    cached = crypto.createHmac('sha256', secret).update('servicebay:internal-api:v1').digest('hex');
    return cached;
}
