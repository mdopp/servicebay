import type { AppConfig } from '@/lib/config';

/**
 * Two install modes — see #249 for the design conversation.
 *
 *  - **`public`**: user has a real public domain (`example.com`).
 *    Services live on `<sub>.<publicDomain>`, with Let's Encrypt SSL
 *    and external access via port-forwarded NPM. The default for
 *    new installs that have a domain ready.
 *  - **`lan`**: no public domain set. Services live on
 *    `<sub>.<lanDomain>` (default `home.arpa`, RFC 8375) via AdGuard
 *    DNS rewrites. HTTP-only on the LAN; no external access; no SSL.
 *    Still a fully-functional install with SSO, friendly URLs, and
 *    reverse proxy. Users can switch to `public` later via
 *    Settings → Reverse Proxy → Add public domain.
 *
 * Pure function, no I/O. Safe to call from server actions and from
 * server-rendered components alike.
 */
export type InstallMode = 'lan' | 'public';

const DEFAULT_LAN_DOMAIN = 'home.arpa';

/** Classify the install based on which domain fields are populated. */
export function getMode(config: Pick<AppConfig, 'reverseProxy'>): InstallMode {
  const domain = config.reverseProxy?.publicDomain;
  return domain && domain.trim() !== '' ? 'public' : 'lan';
}

/**
 * The active domain for the current mode — public domain when set,
 * otherwise the LAN domain (default `home.arpa`). Used by UI labels
 * and URL builders so a single source of truth answers "what suffix
 * do my services live on?".
 */
export function getActiveDomain(config: Pick<AppConfig, 'reverseProxy'>): string {
  const pub = config.reverseProxy?.publicDomain;
  if (pub && pub.trim() !== '') return pub.trim();
  const lan = config.reverseProxy?.lanDomain;
  return lan && lan.trim() !== '' ? lan.trim() : DEFAULT_LAN_DOMAIN;
}

/**
 * Backwards-compatible helper — true iff the install is in `lan` mode.
 * Existing callers from PR #247 use this; new code should call
 * `getMode(config) === 'lan'` for clarity.
 *
 * @deprecated prefer `getMode(config) === 'lan'`.
 */
export function isLocalOnly(config: Pick<AppConfig, 'reverseProxy'>): boolean {
  return getMode(config) === 'lan';
}
