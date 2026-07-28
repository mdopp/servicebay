/**
 * Host-firewall capability handler (#2388).
 *
 * Subscribes to:
 *   - `feature.installed`   → re-render the host firewall including the
 *                             template that just landed.
 *   - `feature.uninstalled` → re-render it EXCLUDING that template.
 *
 * Like every other handler here it is declaration-driven, not
 * template-name-driven: it reads `blockLanAccess` off the port variables
 * a template declares in its `variables.json`, exactly as the nginx
 * handler reads `subdomain`/`proxyConfig` and the Authelia one reads
 * `oidcClient`. Adding the flag to another template needs no code here.
 *
 * Why re-render the FULL desired state on every event rather than
 * add/remove the one template's ports: removal then costs no bookkeeping
 * and can't go stale. A stray firewall rule outliving the service that
 * asked for it is the worst failure mode this feature has, so the
 * uninstall path recomputes from scratch with the template removed and
 * lets `reconcileHostFirewall` converge (down to deleting the table when
 * nothing is left).
 *
 * `exclude` is passed explicitly rather than trusting
 * `config.installedTemplates` to have been rewritten by the time the
 * event fires — the wipe route's ordering is not this module's business.
 */
import { getConfig } from '@/lib/config';
import { getExecutor } from '@/lib/executor';
import { getTemplateVariables } from '@/lib/registry';
import { collectLanBlockedPorts, reconcileHostFirewall, type PortVarDeclaration } from '@/lib/hostFirewall';
import { logger } from '@/lib/logger';
import type { CapabilityBus } from './bus';
import type { FeatureInstalledEvent, FeatureUninstalledEvent, HandlerResult } from './types';
import type { StackVariable } from '@/lib/stackInstall/types';

const HANDLER_NAME = 'host-firewall.lan-block';

interface ReconcileOpts {
  /** Template to fold in even if `installedTemplates` doesn't list it yet (fresh install). */
  include?: string;
  /** Template to leave out regardless of what `installedTemplates` still says (uninstall). */
  exclude?: string;
  /** Resolved values from the event, layered over `config.templateSettings`. */
  eventVariables?: StackVariable[];
}

/**
 * Recompute the desired filtered-port set from config + the template
 * registry and push it to the host. Exported so the boot path can call
 * the same code (see `reconcileHostFirewallOnBoot`).
 */
export async function reconcileFromConfig(opts: ReconcileOpts = {}): Promise<void> {
  const config = await getConfig();

  const installed = new Set(Object.keys(config.installedTemplates ?? {}));
  if (opts.include) installed.add(opts.include);
  if (opts.exclude) installed.delete(opts.exclude);
  const installedTemplates = [...installed];

  const declarations: Record<string, Record<string, PortVarDeclaration> | null> = {};
  for (const template of installedTemplates) {
    declarations[template] = await getTemplateVariables(template);
  }

  // `templateSettings` holds the globals + whatever the wizard persisted.
  // The event's own variables win for the template being installed —
  // they are the values the pod was actually rendered with. Anything
  // neither map knows falls back to the declared default.
  const values: Record<string, string | undefined> = { ...(config.templateSettings ?? {}) };
  for (const v of opts.eventVariables ?? []) {
    if (v.value) values[v.name] = v.value;
  }

  const plan = collectLanBlockedPorts({ installedTemplates, declarations, values });
  for (const reason of plan.skipped) {
    logger.warn('CapabilityBus', `[${HANDLER_NAME}] skipped ${reason}`);
  }
  await reconcileHostFirewall(getExecutor(), plan.ports);
}

async function run(opts: ReconcileOpts, what: string): Promise<HandlerResult> {
  try {
    await reconcileFromConfig(opts);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('CapabilityBus', `[${HANDLER_NAME}] ${what}: ${message}`);
    // Retryable + non-blocking: the install already succeeded, but the
    // failure must be visible as a diagnose finding rather than leaving
    // the operator believing a port is filtered when it isn't.
    return { ok: false, retryable: true, message: `host firewall ${what}: ${message}` };
  }
}

export function handleInstalled(event: FeatureInstalledEvent): Promise<HandlerResult> {
  return run({ include: event.template, eventVariables: event.variables }, `apply for ${event.template}`);
}

export function handleUninstalled(event: FeatureUninstalledEvent): Promise<HandlerResult> {
  return run({ exclude: event.template, eventVariables: event.lastKnownVariables }, `cleanup for ${event.template}`);
}

/**
 * Boot-time reconcile — the counterpart to `updateWindow.applyLocks`.
 *
 * Two jobs. It closes the gap for a box whose stack was installed BEFORE
 * the template declared `blockLanAccess` (the rule would otherwise wait
 * for the operator to redeploy a service that has no other reason to be
 * redeployed), and it self-heals a host where the unit or the table was
 * removed by hand. Idempotent, so a boot with nothing to do converges to
 * a couple of no-op probes.
 */
export async function reconcileHostFirewallOnBoot(): Promise<void> {
  await reconcileFromConfig();
}

export function registerHostFirewallHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
