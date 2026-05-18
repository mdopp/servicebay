/**
 * Capability-bus boot hook (#629 / Phase 4A).
 *
 * Called once at server start. Phase 4A ships the bus + contract; the
 * Authelia / NPM / AdGuard / credentials handlers register themselves
 * here in Phase 4B+:
 *
 *   bus.subscribe('feature.installed', 'authelia.oidc', autheliaHandler);
 *   bus.subscribe('feature.uninstalled', 'authelia.oidc', autheliaHandler);
 *   bus.subscribe('feature.installed', 'nginx.proxy-host', nginxHandler);
 *   bus.subscribe('feature.uninstalled', 'nginx.proxy-host', nginxHandler);
 *   bus.subscribe('feature.installed', 'adguard.dns', adguardHandler);
 *   bus.subscribe('feature.uninstalled', 'adguard.dns', adguardHandler);
 *   bus.subscribe('feature.installed', 'credentials.manifest', credsHandler);
 *
 * Today this function is intentionally empty — registering an unused
 * handler does no harm, but registering with no logic does cause an
 * `emit` to log a misleading "0 results" picture. Keep the seam.
 */
import { logger } from '@/lib/logger';
import { getCapabilityBus } from './bus';

export function initCapabilities(): void {
  // The singleton is constructed on first access. Touch it now so the
  // lazy-construction race (two concurrent boot paths each thinking
  // they own creation) is resolved before any handler registers.
  const bus = getCapabilityBus();
  // Phase 4B (#PH4B): register Authelia + NPM handlers here.
  // Phase 4C (#PH4C): register AdGuard + credentials handlers here.
  // Phase 4D (#PH4D): replace the install runner's hardcoded
  //   `registerOidcClients` / NPM bootstrap / proxy-host / AdGuard
  //   calls with `bus.emit(...)`.
  const counts = (['feature.installing', 'feature.installed', 'feature.uninstalling', 'feature.uninstalled'] as const)
    .map(k => `${k}=${bus.list(k).length}`)
    .join(' ');
  logger.info('CapabilityBus', `Initialised. ${counts}`);
}
