/**
 * NPM (nginx) capability handler (#630 / Phase 4B).
 *
 * Subscribes to:
 *   - `feature.installed`   → creates proxy hosts for the template's
 *                              `subdomain`-typed variables.
 *   - `feature.uninstalled` → deletes those same hosts by domain.
 *
 * Install path is a thin wrapper over the existing
 * `POST /api/system/nginx/proxy-hosts` endpoint — that route already
 * handles cert issuance, forward-auth expansion, LAN-restriction access
 * lists, and idempotent create-if-missing semantics. The bulk of the
 * complexity (~530 LoC inside the route handler) stays there.
 *
 * Uninstall path uses the new `DELETE` method on the same route, called
 * once per host the template would have created. Domain list is derived
 * from `lastKnownVariables` so the uninstall handler can't be tricked
 * by the wizard's freshly-resolved variables drifting between install
 * and wipe.
 *
 * The handler does NOT do NPM bootstrap (admin credentials seeding) —
 * that's still the install runner's `runPostInstall` job (#PH4D revisits).
 * If the underlying API call fails because NPM isn't bootstrapped yet,
 * the handler surfaces a retryable error and the diagnose finding
 * tells the operator to redeploy nginx first.
 */
import { buildProxyHosts } from '@/lib/stackInstall/postInstall';
import { logger } from '@/lib/logger';
import { internalFetch } from '@/lib/api/internalFetch';
import type { CapabilityBus } from './bus';
import type {
  FeatureInstalledEvent,
  FeatureUninstalledEvent,
  HandlerResult,
} from './types';

const HANDLER_NAME = 'nginx.proxy-host';

export async function handleInstalled(event: FeatureInstalledEvent): Promise<HandlerResult> {
  const { domain, hosts } = buildProxyHosts(event.variables);
  // Filter to the hosts this specific template owns. `buildProxyHosts`
  // walks the full variable list; the `service` field carries the
  // owning template name (from `subdomain.templateName` or derived from
  // the variable name). We only want this template's hosts to fire on
  // its own install event.
  const ownHosts = hosts.filter(h => h.service === event.template);
  if (!domain || ownHosts.length === 0) return { ok: true };

  try {
    const res = await internalFetch('/api/system/nginx/proxy-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hosts: ownHosts,
        publicDomain: domain,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      // 401 from this endpoint means NPM admin credentials aren't seeded
      // yet — runner's bootstrap step is supposed to run first. Surface
      // as retryable so the diagnose finding tells the operator what to
      // do, rather than failing the install outright.
      return { ok: false, retryable: true, message: `proxy-host create: ${message}` };
    }
    const data = await res.json().catch(() => ({}));
    const created: string[] = Array.isArray(data.created) ? data.created : [];
    if (created.length > 0) {
      logger.info('CapabilityBus', `[${HANDLER_NAME}] Created proxy host(s) for ${event.template}: ${created.join(', ')}`);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, retryable: true, message: `proxy-host create: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function handleUninstalled(event: FeatureUninstalledEvent): Promise<HandlerResult> {
  // We don't have `manifest` on the uninstalled event by design — the
  // template's on-disk metadata may differ from what was actually
  // installed. Variables are the snapshot the handler trusts.
  const { hosts } = buildProxyHosts(event.lastKnownVariables);
  const ownHosts = hosts.filter(h => h.service === event.template);
  if (ownHosts.length === 0) return { ok: true };

  const failures: string[] = [];
  for (const host of ownHosts) {
    try {
      const res = await internalFetch(
        `/api/system/nginx/proxy-hosts?domain=${encodeURIComponent(host.domain)}`,
        { method: 'DELETE' },
      );
      // 404 = already gone — idempotent uninstall success.
      if (res.ok || res.status === 404) {
        logger.info('CapabilityBus', `[${HANDLER_NAME}] Removed proxy host ${host.domain} for ${event.template} (status ${res.status}).`);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      failures.push(`${host.domain}: ${message}`);
    } catch (e) {
      failures.push(`${host.domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    retryable: true,
    message: `proxy-host delete: ${failures.join('; ')}`,
  };
}

export function registerNginxHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
