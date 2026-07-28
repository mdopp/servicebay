/**
 * Image-digest reads via podman — the two primitives everything else compares
 * (#1859, extracted to a leaf module in #2397).
 *
 *   - `getRunningImageDigest` — the digest of the image sitting in a node's
 *     local store (`podman inspect <image>`), i.e. what a container will start
 *     from right now;
 *   - `getRegistryImageDigest` — the digest the registry currently publishes
 *     for that same tag (`podman manifest inspect <image>`).
 *
 * Both reuse `updater.ts`'s `extractImageDigest` (multi-arch manifest-list →
 * linux/amd64 digest, falling back to a single image document's config/`Digest`
 * field), generalised from ServiceBay's own hard-coded `:latest` to an
 * arbitrary image ref on an arbitrary node.
 *
 * Why its own file: `imageDigest.ts` (the installed-services fan-out that used
 * to hold these) imports the install runner, which transitively reaches
 * `ServiceManager` — so a service-side caller like `services/forceUpdate.ts`
 * importing it closed a dependency cycle. This module depends only on the
 * executor, the manifest parser and the logger, so any layer may read digests.
 *
 * A null digest means **unknown** (registry unreachable, image not pulled,
 * podman error). Callers must never read null as "unchanged" (memory
 * `feedback_dont_mask_failures`).
 */
import { getExecutor } from '@/lib/executor';
import { extractImageDigest } from '@/lib/updater';
import { logger } from '@/lib/logger';

const INSPECT_TIMEOUT_MS = 30 * 1000;

/**
 * The single comparison rule. An update is available only when we know BOTH
 * digests and they differ. A missing/unknown digest on either side is NOT an
 * update (we can't prove a change) — exported so the unit tests can cover the
 * running==registry / differ / missing cases without any podman.
 */
export function isUpdateAvailable(
  runningDigest: string | null | undefined,
  registryDigest: string | null | undefined,
): boolean {
  if (!runningDigest || !registryDigest) return false;
  return runningDigest !== registryDigest;
}

/**
 * Resolve the digest the **registry** currently serves for `image`. Mirrors
 * updater.ts's `getRemoteImageDigest` (same `podman manifest inspect` +
 * `extractImageDigest`), generalised to an arbitrary image ref. Cheap: the
 * manifest is a few KB, not the layers. Returns null on any error — callers
 * treat null as "unknown", never "unchanged".
 *
 * `nodeName` defaults to `Local`; the force-update action (#2397) passes the
 * node the service actually runs on, since a service's images live in that
 * node's image store, not the control plane's.
 */
export async function getRegistryImageDigest(image: string, nodeName = 'Local'): Promise<string | null> {
  try {
    const executor = getExecutor(nodeName);
    const { stdout } = await executor.execArgv(['podman', 'manifest', 'inspect', image], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    return extractImageDigest(JSON.parse(stdout));
  } catch (e) {
    logger.warn('imageDigest', `getRegistryImageDigest(${image}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Resolve the digest of the locally-pulled image the service is **running**,
 * via `podman inspect <image>`. `extractImageDigest` reads the single-image
 * inspect document's config/`Digest` field. Returns null on any error.
 *
 * `nodeName` defaults to `Local` (see `getRegistryImageDigest`).
 */
export async function getRunningImageDigest(image: string, nodeName = 'Local'): Promise<string | null> {
  try {
    const executor = getExecutor(nodeName);
    const { stdout } = await executor.execArgv(['podman', 'inspect', image], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout);
    // `podman inspect` returns an array (one entry per matched object).
    const doc = Array.isArray(parsed) ? parsed[0] : parsed;
    return extractImageDigest(doc);
  } catch (e) {
    logger.warn('imageDigest', `getRunningImageDigest(${image}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
