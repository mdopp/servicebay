import type { AppConfig } from '@/lib/config';

/**
 * "Local-only mode" — a runtime classification we derive from config so
 * the rest of the app can branch on a single boolean rather than
 * scattering `if (!publicDomain)` checks. True iff there is no
 * `reverseProxy.publicDomain` set; in that case ServiceBay skips
 * Authelia / OIDC auto-registration, NPM proxy-host creation, and any
 * step that assumes services are reachable on a public hostname.
 *
 * Pure function, no I/O, no network. Safe to call from server actions
 * and from server-rendered components alike.
 */
export function isLocalOnly(config: Pick<AppConfig, 'reverseProxy'>): boolean {
  const domain = config.reverseProxy?.publicDomain;
  return !domain || domain.trim() === '';
}
