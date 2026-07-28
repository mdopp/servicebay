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
import {
  collectLanBlockedPorts,
  reconcileHostFirewall,
  type LanBlockPlan,
  type PortVarDeclaration,
} from '@/lib/hostFirewall';
import { recordHandlerFailure, clearHandlerFailure } from '@/lib/install/handlerFailures';
import { logger } from '@/lib/logger';
import type { CapabilityBus } from './bus';
import type { FeatureInstalledEvent, FeatureUninstalledEvent, HandlerResult } from './types';
import type { StackVariable } from '@/lib/stackInstall/types';

const HANDLER_NAME = 'host-firewall.lan-block';

/**
 * `service` key the boot-reconcile failure is recorded under. Not a real
 * service — the host firewall is box-level — but the standing-failure
 * store is keyed `${kind}:${service}` and this is what the operator sees
 * as the row label.
 */
export const BOOT_FAILURE_SERVICE = 'host-firewall';

interface ReconcileOpts {
  /** Template to fold in even if `installedTemplates` doesn't list it yet (fresh install). */
  include?: string;
  /** Template to leave out regardless of what `installedTemplates` still says (uninstall). */
  exclude?: string;
  /** Resolved values from the event, layered over `config.templateSettings`. */
  eventVariables?: StackVariable[];
}

/**
 * Compute the DESIRED filtered-port set from config + the template
 * registry, without touching the host. Split out of
 * {@link reconcileFromConfig} so the `host_firewall_rule` diagnose probe
 * can ask "what should be filtered?" and compare it against what the
 * kernel actually has loaded (#2420) without re-applying anything.
 */
export async function planLanBlockedPorts(opts: ReconcileOpts = {}): Promise<LanBlockPlan> {
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

  return collectLanBlockedPorts({ installedTemplates, declarations, values });
}

/**
 * Recompute the desired filtered-port set from config + the template
 * registry and push it to the host. Exported so the boot path can call
 * the same code (see `reconcileHostFirewallOnBoot`).
 */
export async function reconcileFromConfig(opts: ReconcileOpts = {}): Promise<void> {
  const plan = await planLanBlockedPorts(opts);
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
 *
 * A failure here used to be a log line and nothing else, so the #2388
 * LAN block could silently not apply on a box that depends entirely on
 * this path (#2420). It now lands in `config.installHandlerFailures` —
 * the same store the capability-bus path writes through `runner.ts` —
 * so the `install_handler_failed` probe surfaces it with a retry, and
 * the error still propagates so the caller's log line is unchanged.
 */
export async function reconcileHostFirewallOnBoot(): Promise<void> {
  try {
    await reconcileFromConfig();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordHandlerFailure({
      kind: 'host-firewall',
      service: BOOT_FAILURE_SERVICE,
      message: `boot reconcile: ${message}`,
    });
    throw e;
  }
  // Converged — drop any record a previous boot left standing.
  await clearHandlerFailure('host-firewall', BOOT_FAILURE_SERVICE);
}

export function registerHostFirewallHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
