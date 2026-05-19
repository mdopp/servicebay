/**
 * Stack-level health aggregation (#633 / Phase 5A).
 *
 * One value answers "is stack X healthy?" by joining each child
 * template's `twin.services[].health.ready` field (populated by the
 * service-health poller from #626).
 *
 * Used by:
 *   - The cross-stack dependency gate (`stackRunner.canInstall`) —
 *     refuses to install a stack whose declared dependencies aren't
 *     all `ready`.
 *   - Phase 5C's tier-status gate — feature-stack installs are
 *     blocked when any `tier: core` stack reports `ready: false`.
 *
 * Children with no health record yet are reported as `unknown`. The
 * caller decides whether to treat that as ready (e.g. during the
 * first 30 seconds after a fresh deploy before the poller has run)
 * or as a hard fail.
 */
import { DigitalTwinStore } from '@/lib/store/twin';
import { getStackManifest } from '@/lib/registry';
import { getConfig } from '@/lib/config';

export type ChildHealthState = 'ready' | 'unhealthy' | 'unknown';

export interface StackHealth {
  /** True iff every child reports ready=true. `unknown` counts as not-ready. */
  ready: boolean;
  /** True if any child is reachable but reports degraded. Informational. */
  degraded: boolean;
  /** Per-child status. Keys are template names from the stack manifest. */
  children: Record<string, ChildHealthState>;
  /** When at least one child has been probed at all. Distinguishes "fully
   *  uninstalled" from "fresh boot, poller hasn't run". */
  hasAnySignal: boolean;
}

/** Pure version — caller provides the twin snapshot and the manifest.
 *  Exposed for testing without needing to bootstrap the singleton. */
export function aggregateStackHealth(
  templateNames: readonly string[],
  serviceHealthByName: ReadonlyMap<string, { ready: boolean; degraded?: boolean } | undefined>,
): StackHealth {
  const children: Record<string, ChildHealthState> = {};
  let degraded = false;
  let hasAnySignal = false;
  let allReady = templateNames.length > 0;
  for (const name of templateNames) {
    const h = serviceHealthByName.get(name);
    if (!h) {
      children[name] = 'unknown';
      allReady = false;
      continue;
    }
    hasAnySignal = true;
    if (h.degraded) degraded = true;
    if (h.ready) {
      children[name] = 'ready';
    } else {
      children[name] = 'unhealthy';
      allReady = false;
    }
  }
  return { ready: allReady, degraded, children, hasAnySignal };
}

/**
 * One degraded core stack — UI-shaped summary for the tier-gate
 * refusal modal and the CoreHealthBanner (#635 / Phase 5C). Names
 * the stack + its unhealthy children so the operator can act without
 * re-reading the diagnose page.
 */
/**
 * Best-effort cause inference (#665 — S5). When a known unhealthy
 * pattern matches missing config we can hint at the recovery instead
 * of leaving the operator to triage a generic "adguard unhealthy" red
 * banner. Patterns must be conservative — a wrong hint is worse than
 * none.
 */
export interface UnhealthyCause {
  /** Short headline rendered next to the template name. */
  summary: string;
  /** Optional action label + href for the banner button. */
  action?: { label: string; href: string };
}

export interface NotReadyChild {
  template: string;
  state: 'unhealthy' | 'unknown';
  /** Populated when a known config-side cause matches (#665 — S5). */
  cause?: UnhealthyCause;
}

export interface DegradedCoreEntry {
  stack: string;
  /** Friendly label from the stack's manifest. */
  label: string;
  /** Per-child state; only `unhealthy` / `unknown` keys appear. */
  notReady: NotReadyChild[];
}

/**
 * Scan every stack whose manifest declares `tier: core` and return the
 * subset that isn't `health.ready === true`. Used by:
 *   - `installStack` to refuse feature-stack installs when core is
 *     degraded (#635 / Phase 5C tier gate).
 *   - `<CoreHealthBanner>` to show what's broken with click-through
 *     to diagnose actions.
 */
/**
 * Map an unhealthy template name to a known cause when config is the
 * obvious blocker. Pure read of config; no agent calls. New patterns
 * land here when a recurring "X unhealthy because Y" emerges from
 * field reports — keep the matcher narrow so unrelated unhealthy
 * states still fall through to the generic banner copy.
 */
async function inferCause(
  template: string,
  config: { reverseProxy?: { lanIp?: string; publicDomain?: string } },
): Promise<UnhealthyCause | undefined> {
  if (template === 'adguard' && !config.reverseProxy?.lanIp) {
    return {
      summary: 'AdGuard depends on the install-time LAN IP. It hasn\'t been captured yet — wildcard DNS rewrites can\'t be provisioned.',
      action: { label: 'Reconcile LAN IP', href: '/diagnose' },
    };
  }
  if (template === 'nginx' && !config.reverseProxy?.publicDomain) {
    return {
      summary: 'NPM proxy hosts depend on a publicDomain. Wizard didn\'t capture one yet (or LAN-only install).',
      action: { label: 'Open wizard', href: '/setup' },
    };
  }
  return undefined;
}

export async function getDegradedCoreSummary(nodeName: string = 'Local'): Promise<DegradedCoreEntry[]> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const stacksDir = path.join(process.cwd(), 'stacks');
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(stacksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = dirents.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);

  // Load config once for cause inference (#665 — S5).
  let cfg: { reverseProxy?: { lanIp?: string; publicDomain?: string } } = {};
  try { cfg = await getConfig(); } catch { /* cause hints stay empty */ }

  const degraded: DegradedCoreEntry[] = [];
  for (const name of names) {
    let manifest;
    try {
      manifest = await getStackManifest(name);
    } catch { continue; }
    if (!manifest || manifest.tier !== 'core') continue;
    const health = await getStackHealth(name, nodeName);
    if (!health || health.ready) continue;
    const notReady = await Promise.all(
      Object.entries(health.children)
        .filter(([, s]) => s !== 'ready')
        .map(async ([template, state]): Promise<NotReadyChild> => ({
          template,
          state: state as 'unhealthy' | 'unknown',
          cause: state === 'unhealthy' ? await inferCause(template, cfg) : undefined,
        })),
    );
    degraded.push({ stack: name, label: manifest.label, notReady });
  }
  return degraded;
}

/**
 * Runtime entry point: look up the stack manifest, scan the twin for
 * each child template's health, return aggregated result.
 *
 * Returns `null` when the stack has no manifest (legacy README-only).
 * Throws when the manifest exists but is structurally broken (per
 * `getStackManifest`'s contract — caught by the consistency lint at
 * build time, surfaces here only on a runtime registry mismatch).
 */
export async function getStackHealth(
  stackName: string,
  nodeName: string = 'Local',
): Promise<StackHealth | null> {
  const manifest = await getStackManifest(stackName);
  if (!manifest) return null;
  const twin = DigitalTwinStore.getInstance();
  const node = twin.nodes[nodeName];
  const services = node?.services ?? [];
  const map = new Map<string, { ready: boolean; degraded?: boolean }>();
  for (const svc of services) {
    if (!svc.health) continue;
    map.set(svc.name, { ready: svc.health.ready, degraded: svc.health.degraded });
  }
  return aggregateStackHealth(manifest.templates, map);
}
