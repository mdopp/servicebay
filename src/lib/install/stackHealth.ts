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
