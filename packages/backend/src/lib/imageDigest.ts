/**
 * Per-service image-update detection (#1859, child 1 of #1858).
 *
 * Answers "is the registry serving a newer image than the one this service is
 * running?" for every installed service, by comparing two digests:
 *
 *   - the **running** digest: the locally-pulled image the service runs, read
 *     from `podman inspect <image>`;
 *   - the **registry** digest: what the registry currently publishes for that
 *     same tag, read from `podman manifest inspect <image>`.
 *
 * The registry side intentionally REUSES updater.ts's `extractImageDigest`
 * (the multi-arch manifest-list → linux/amd64 digest extraction) and the same
 * `podman manifest inspect` convention, generalised here from the hard-coded
 * `:latest` ServiceBay image to an arbitrary image ref. `extractImageDigest`
 * applies equally to the single-image `podman inspect` document (it falls back
 * to the config/`Digest` field), so both sides share one parser.
 *
 * A null digest on either side means "unknown" (registry unreachable, image
 * not pulled, podman error). We never treat unknown as "no update" with a
 * false negative *or* claim an update on a guess — `updateAvailable` is only
 * `true` when both digests are known AND differ (memory
 * feedback_dont_mask_failures).
 */
import { getExecutor } from '@/lib/executor';
import { getConfig } from '@/lib/config';
import { getTemplateYaml } from '@/lib/registry';
import { collectImagesToPull } from '@/lib/install/runner';
import { extractImageDigest } from '@/lib/updater';
import { logger } from '@/lib/logger';

const INSPECT_TIMEOUT_MS = 30 * 1000;

export interface ServiceImageUpdate {
  service: string;
  image: string;
  /** Digest of the locally-pulled image the service runs; null if unknown. */
  runningDigest: string | null;
  /** Digest the registry currently publishes for the tag; null if unknown. */
  registryDigest: string | null;
  /** True iff both digests are known and differ. Unknown → false, never crash. */
  updateAvailable: boolean;
}

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
 */
export async function getRegistryImageDigest(image: string): Promise<string | null> {
  try {
    const executor = getExecutor('Local');
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
 */
export async function getRunningImageDigest(image: string): Promise<string | null> {
  try {
    const executor = getExecutor('Local');
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

/**
 * Build the running-vs-registry comparison for a single service/image pair.
 * Both lookups run, even if one is unknown, so the caller always gets both
 * digest fields back for diagnostics.
 */
export async function getServiceImageUpdate(service: string, image: string): Promise<ServiceImageUpdate> {
  const [runningDigest, registryDigest] = await Promise.all([
    getRunningImageDigest(image),
    getRegistryImageDigest(image),
  ]);
  return {
    service,
    image,
    runningDigest,
    registryDigest,
    updateAvailable: isUpdateAvailable(runningDigest, registryDigest),
  };
}

/**
 * Fan out across every installed service and report whether each has a newer
 * image waiting in the registry. Mirrors the upgrades-pending route's pattern:
 * iterate `config.installedTemplates`, skip names that fail the registry's own
 * validation, pull the template yaml, and reuse `collectImagesToPull` to lift
 * the `image:` ref out of it. A single service failing yaml-read or a podman
 * error never takes the whole aggregate down.
 */
export async function getInstalledImageUpdates(): Promise<ServiceImageUpdate[]> {
  const config = await getConfig();
  const installed = config.installedTemplates ?? {};

  const results: ServiceImageUpdate[] = [];
  for (const name of Object.keys(installed)) {
    // Same gate the upgrades-pending route uses — a name that wouldn't pass
    // template-name validation can't have a yaml to read anyway.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
    try {
      const yaml = await getTemplateYaml(name);
      if (yaml === null) continue;
      // Reuse the install runner's `image:` extractor (regex-based, tolerant of
      // Mustache placeholders). One service may declare several images; report
      // each so the UI can flag any container with a pending update.
      const images = collectImagesToPull([{ name, yaml }]);
      for (const image of images) {
        results.push(await getServiceImageUpdate(name, image));
      }
    } catch (e) {
      logger.warn('imageDigest', `getInstalledImageUpdates skipped ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return results;
}
