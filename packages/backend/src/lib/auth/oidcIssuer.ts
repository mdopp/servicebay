/**
 * OIDC issuer URL validator (#577).
 *
 * Threat model: an operator (or attacker with config-write access)
 * points `config.oidc.issuer` at an internal service like
 * `http://127.0.0.1:7878` to use ServiceBay's OIDC fetch as an SSRF
 * primitive. The previous code path then logged the response body on
 * error (`logger.error('OIDC token exchange failed', await
 * tokenResponse.text())`), exfiltrating internal service responses
 * through ServiceBay's log surface.
 *
 * Constraints — `assertValidOidcIssuer` must not break the homelab
 * shape: many operators rewrite `auth.<publicDomain>` to a LAN IP via
 * AdGuard so the auth subdomain is reachable internally. So we can't
 * just blanket-block RFC1918. What we DO block:
 *
 *   - non-`https://` schemes (eliminates `file://`, `gopher://`, etc.
 *     and forces TLS so credentials don't ride plaintext)
 *   - userinfo in the URL (`https://user:pass@host` — useless for OIDC
 *     and only useful as a phishing primitive)
 *   - `localhost` / `127.0.0.0/8` — never a legitimate OIDC issuer
 *     since the discovery doc and JWKS need to be reachable from
 *     the same hostname browsers redirect to
 *   - link-local (`169.254.0.0/16`, `fe80::/10`) — same logic
 *
 * RFC1918 is allowed: a homelab Authelia on `10.0.0.5` is a
 * legitimate issuer. The browser-side redirect makes loopback
 * pointless as an OIDC target anyway.
 *
 * Separately, the callback handler MUST NOT log response bodies on
 * error — that's the actual leak channel and the validation above
 * doesn't help if a future code path reintroduces the log.
 */

import { isIP } from 'net';

export function assertValidOidcIssuer(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('OIDC issuer must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error(`OIDC issuer must use https:// (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error('OIDC issuer must not contain userinfo (user:pass@…)');
  }

  // Strip the [] wrapping that URL parses for IPv6 literals so isIP()
  // matches the bare address.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('OIDC issuer must not be localhost — set the public auth hostname');
  }
  // Direct IPv4 check covers /etc/hosts overrides + IP literals.
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 0) {
      throw new Error(`OIDC issuer must not be loopback (${host})`);
    }
    if (parts[0] === 169 && parts[1] === 254) {
      throw new Error(`OIDC issuer must not be link-local (${host})`);
    }
  }
  if (isIP(host) === 6) {
    if (host === '::1' || host === '::' || host.startsWith('fe80')) {
      throw new Error(`OIDC issuer must not be loopback / link-local (${host})`);
    }
  }
}
