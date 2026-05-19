/**
 * Capability-bus boot hook (#629 / Phase 4A, extended #630 / Phase 4B).
 *
 * Called once at server start. Registers every platform-service
 * handler with the bus so feature install / uninstall events flow into
 * the right cross-service plumbing.
 *
 * Phase 4B handlers: Authelia (OIDC clients) + NPM (proxy hosts).
 * Phase 4C handlers (#631): AdGuard (DNS rewrites) + credentials
 * manifest persistence.
 * Phase 4D (#632): replaces the install runner's hardcoded
 * `registerOidcClients` / NPM bootstrap / proxy-host / AdGuard calls
 * with `bus.emit(...)`.
 */
import { logger } from '@/lib/logger';
import { getCapabilityBus } from './bus';
import { registerAutheliaHandlers } from './authelia';
import { registerNginxHandlers } from './nginx';

export function initCapabilities(): void {
  const bus = getCapabilityBus();
  registerAutheliaHandlers(bus);
  registerNginxHandlers(bus);
  const counts = (['feature.installing', 'feature.installed', 'feature.uninstalling', 'feature.uninstalled'] as const)
    .map(k => `${k}=${bus.list(k).length}`)
    .join(' ');
  logger.info('CapabilityBus', `Initialised. ${counts}`);
}
