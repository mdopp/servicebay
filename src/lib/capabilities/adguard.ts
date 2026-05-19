/**
 * AdGuard capability handler (#631 / Phase 4C).
 *
 * Adds and removes per-subdomain DNS rewrites in AdGuard as feature
 * templates are installed and uninstalled. The portal provisioner
 * still owns the apex + wildcard rewrites (`<domain>`, `www.<domain>`,
 * `*.<domain>`) — those are AdGuard-self-configuration, not per-
 * template state.
 *
 * Per-subdomain rewrites are largely redundant with the wildcard when
 * every subdomain points at the same LAN IP. We add them anyway:
 *
 *   - `ensureWildcardRewrite` is idempotent (returns `unchanged` when
 *     the rule already exists with the same target).
 *   - Future templates can declare `subdomain` variables that resolve
 *     to a non-default IP — the per-subdomain rule overrides the
 *     wildcard for that specific name.
 *   - Uninstall cleans the AdGuard rule list, keeping the rewrite set
 *     in lock-step with the deployed services for diagnose readers
 *     that audit the two.
 *
 * Handler scope: only `subdomain` variables whose `exposure` is
 * `lan` or `internal`. `public` exposure relies on public DNS, not on
 * AdGuard's split-horizon. `lan` and `internal` both terminate
 * resolution inside AdGuard at the LAN IP — NPM does the rest.
 *
 * Result semantics:
 *   - AdGuard not deployed yet → `{ ok: true }` (soft skip). The
 *     install flow will fire this event before AdGuard is up when
 *     installing AdGuard itself.
 *   - Per-name failure → aggregated as one `{ ok: false, retryable:
 *     true, message }` so siblings still get attempted.
 */
import {
  ensureWildcardRewrite,
  removeWildcardRewrite,
} from '@/lib/adguard/rewrites';
import { findAdguardCreds, findServiceBayLanIp } from '@/lib/portal/provisioner';
import { logger } from '@/lib/logger';
import type { StackVariable } from '@/lib/stackInstall/types';
import type { CapabilityBus } from './bus';
import type {
  FeatureInstalledEvent,
  FeatureUninstalledEvent,
  HandlerResult,
} from './types';

const HANDLER_NAME = 'adguard.dns';

/**
 * Subdomains owned by this template that need an AdGuard rewrite. We
 * intentionally match `nginx.handleInstalled`'s ownership rule
 * (`templateName === template`) so the two handlers don't disagree on
 * which template "owns" a host.
 */
function rewriteNamesFor(template: string, variables: StackVariable[]): string[] {
  const domain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
  if (!domain) return []; // pure LAN-only install — wildcard handles everything
  const out: string[] = [];
  for (const v of variables) {
    if (v.meta?.type !== 'subdomain') continue;
    if (!v.value) continue;
    if (v.meta.templateName !== template) continue;
    // `public` exposure is served by public DNS; no AdGuard side.
    const exposure = v.meta.exposure;
    if (exposure !== 'lan' && exposure !== 'internal') continue;
    out.push(`${v.value}.${domain}`);
  }
  return out;
}

export async function handleInstalled(event: FeatureInstalledEvent): Promise<HandlerResult> {
  const names = rewriteNamesFor(event.template, event.variables);
  if (names.length === 0) return { ok: true };

  const creds = await findAdguardCreds();
  const lanIp = await findServiceBayLanIp();
  if (!creds || !lanIp) {
    // AdGuard hasn't seeded creds yet (first install) or install-time
    // LAN-IP detection hasn't run. Soft skip — the portal provisioner
    // will sweep up missing rewrites once both land.
    logger.info('CapabilityBus', `[${HANDLER_NAME}] AdGuard not configured yet; skipping rewrites for ${event.template}.`);
    return { ok: true };
  }

  const failures: string[] = [];
  for (const name of names) {
    const result = await ensureWildcardRewrite(creds, name, lanIp);
    if (result === 'failed') failures.push(name);
    else logger.info('CapabilityBus', `[${HANDLER_NAME}] ${result} ${name} → ${lanIp}`);
  }
  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    retryable: true,
    message: `adguard rewrite add: ${failures.join(', ')}`,
  };
}

export async function handleUninstalled(event: FeatureUninstalledEvent): Promise<HandlerResult> {
  const names = rewriteNamesFor(event.template, event.lastKnownVariables);
  if (names.length === 0) return { ok: true };

  const creds = await findAdguardCreds();
  if (!creds) {
    // No creds = nothing to clean; the rewrites either don't exist or
    // we can't reach them, both of which the operator can resolve later.
    return { ok: true };
  }

  const failures: string[] = [];
  for (const name of names) {
    const result = await removeWildcardRewrite(creds, name);
    if (result === 'failed') failures.push(name);
    else logger.info('CapabilityBus', `[${HANDLER_NAME}] ${result} ${name}`);
  }
  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    retryable: true,
    message: `adguard rewrite remove: ${failures.join(', ')}`,
  };
}

export function registerAdguardHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
