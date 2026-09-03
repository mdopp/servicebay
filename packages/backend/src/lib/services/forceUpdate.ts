/**
 * Operator-triggered "force update" for a service's container image(s) (#2397).
 *
 * Why this exists: a plain restart re-runs the unit against the image already
 * in the node's local store, so a freshly pushed `:latest` never lands; and
 * `podman-auto-update.timer` is *masked* until an operator configures an update
 * window (`updateWindow.ts`'s `applyLocks`), so on a default box nothing
 * re-checks the registry on its own at all. This is the manual path that
 * depends on neither.
 *
 * The registry-digest comparison is deliberately NOT reinvented here:
 * `lib/podmanDigest.ts` already generalised `updater.ts`'s `podman manifest
 * inspect` + `extractImageDigest` pattern from ServiceBay's own `:latest` to an
 * arbitrary image ref on an arbitrary node (#1859; moved out of
 * `lib/imageDigest.ts` into that leaf module here so the service layer can read
 * digests without a cycle). This module adds the *action* on top of that read
 * model — pull, recreate, and report per image what actually moved.
 *
 * Two modes:
 *   - `pull` (default) — pull first (the service stays up during the download),
 *     then stop + force-remove the containers + start, so the unit cannot come
 *     back up on the old image. The recreate is *structural*, not verified
 *     after the fact: `systemctl restart` alone reuses the existing container
 *     and silently keeps the old image (#2063), and the only way to be sure is
 *     to delete the container.
 *   - `fresh` — the fallback for a genuinely stuck image: stop, remove the
 *     containers, DELETE the local image, pull it again from scratch, start.
 *     For when `pull` reports the local image still isn't the one the registry
 *     publishes (a corrupt/pinned local layer set).
 *
 * Nothing is masked: every image carries its before/registry/after digests, so
 * a no-op is visibly a no-op instead of a cheerful "update sent" (memory
 * `feedback_dont_mask_failures`).
 */
import yaml from 'js-yaml';
import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';
import { getContainers } from '@/lib/store/repository';
import { getRegistryImageDigest, getRunningImageDigest } from '@/lib/podmanDigest';
import { ServiceListing } from './serviceListing';
import { collectImagesFromKubeYaml } from './serviceLifecycle';

/** A pull can be multi-GB on a slow line; systemd's own unit budget is 600 s
 *  for a start, but the pull happens outside it here so give it real room. */
const PULL_TIMEOUT_MS = 30 * 60 * 1000;
/** `systemctl stop` on a `.kube` unit runs `podman kube down` — seconds
 *  normally, but a wedged container can take a while to be killed. */
const STOP_TIMEOUT_MS = 3 * 60 * 1000;
const SHORT_TIMEOUT_MS = 60 * 1000;

type ForceUpdateMode = 'pull' | 'fresh';

interface ForceUpdateImage {
  image: string;
  /** Local image digest before the pull; null = not present / unknown. */
  before: string | null;
  /** Digest the registry publishes for the tag right now; null = unknown. */
  registry: string | null;
  /** Local image digest after the pull; null = unknown. */
  after: string | null;
  /** The `podman pull` itself succeeded. */
  pulled: boolean;
  /** The local image genuinely advanced (before ≠ after, after known). */
  changed: boolean;
  /**
   * Both digests are known and the local image is STILL not the one the
   * registry publishes — i.e. the pull did not take. This is the signal that
   * the `fresh` fallback is the next thing to try.
   */
  stale: boolean;
  /** `fresh` mode deleted the local image before re-pulling it. */
  removedLocally: boolean;
  /** Pull/remove failure message, if any. Never thrown away silently. */
  error?: string;
}

export interface ForceUpdateResult {
  service: string;
  node: string;
  mode: ForceUpdateMode;
  images: ForceUpdateImage[];
  /** Container names force-removed so the unit had to rebuild them. */
  recreated: string[];
  /** Any image advanced to a new digest. */
  changed: boolean;
  /** Any image is still behind the registry → offer the `fresh` fallback. */
  stale: boolean;
  /** `systemctl status` text for the unit after the action — same field the
   *  sibling `update` action (`updateAndRestartService`) returns. The start is
   *  `--no-block`, so `activating` here is normal, not a failure. */
  status: string;
  logs: string[];
}

/** Strip a systemd/Quadlet suffix so `media.service` and `media` are one key. */
function baseName(name: string): string {
  return name.replace(/\.(service|kube|container|scope|socket|timer)$/, '');
}

/**
 * Every image ref a service's on-disk definition declares.
 *
 * Two artifact shapes (the same split `get_service_files` documents): a `.kube`
 * service keeps its images in the pod spec (`yamlContent`), while a
 * single-container `.container` Quadlet declares one `Image=` directive in the
 * unit body itself (`kubeContent`) and has no pod spec at all — the ollama GPU
 * fixup, and exactly the service the issue named as stuck.
 *
 * Pure + exported so the parsing is unit-testable without a node.
 */
export function collectServiceImages(files: {
  quadletKind?: 'kube' | 'container';
  kubeContent?: string;
  yamlContent?: string;
}): string[] {
  const images = new Set<string>();
  if (files.quadletKind === 'container') {
    for (const m of (files.kubeContent ?? '').matchAll(/^\s*Image\s*=\s*(\S+)\s*$/gm)) {
      images.add(m[1]);
    }
    return [...images];
  }
  try {
    const parsed = yaml.load(files.yamlContent ?? '');
    for (const image of collectImagesFromKubeYaml(parsed)) images.add(image);
  } catch (e) {
    logger.warn('forceUpdate', `pod spec parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return [...images];
}

/** The twin's containers that belong to `service` (infra containers excluded —
 *  they are owned by the pod, which `podman kube down` removes wholesale). */
function serviceContainerNames(nodeName: string, service: string): string[] {
  const owner = baseName(service);
  const names: string[] = [];
  for (const c of getContainers(nodeName)) {
    if (c.isInfra) continue;
    const unit = c.labels?.['PODMAN_SYSTEMD_UNIT'] ?? '';
    if (baseName(unit || c.podName || '') !== owner) continue;
    const name = c.names?.[0];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Is `image` also in use by some OTHER service on this node? `podman rmi -f`
 * would force-remove those containers too, taking an unrelated service down
 * until systemd restarts it — so the `fresh` path skips the delete and says so
 * rather than collaterally killing a neighbour.
 */
function imageSharedWithOtherService(nodeName: string, image: string, service: string): boolean {
  const owner = baseName(service);
  return getContainers(nodeName).some((c) => {
    if (c.isInfra) return false;
    if (c.image !== image && !c.image?.startsWith(`${image}@`)) return false;
    const unit = c.labels?.['PODMAN_SYSTEMD_UNIT'] ?? '';
    return baseName(unit || c.podName || '') !== owner;
  });
}

type Exec = ReturnType<typeof getExecutor>;

/** Run a podman/systemctl argv, returning the error message instead of throwing
 *  — every step here is best-effort-and-reported, never fatal-and-silent. */
async function tryExec(executor: Exec, argv: string[], timeoutMs: number): Promise<string | null> {
  try {
    await executor.execSafe(argv, { timeoutMs });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Force-remove the service's containers so the unit must rebuild them from the
 *  freshly pulled image (#2063 — a restart alone reuses the old container). */
async function removeContainers(
  executor: Exec, nodeName: string, service: string, logs: string[],
): Promise<string[]> {
  const names = serviceContainerNames(nodeName, service);
  const removed: string[] = [];
  for (const name of names) {
    const err = await tryExec(executor, ['podman', 'rm', '-f', '--ignore', name], SHORT_TIMEOUT_MS);
    if (err) {
      logs.push(`Could not remove container ${name}: ${err}`);
    } else {
      removed.push(name);
      logs.push(`Removed container ${name}`);
    }
  }
  if (names.length === 0) logs.push('No running containers to remove (unit already down).');
  return removed;
}

async function pullOne(executor: Exec, entry: ForceUpdateImage, logs: string[]): Promise<void> {
  logs.push(`Pulling ${entry.image}…`);
  const err = await tryExec(executor, ['podman', 'pull', entry.image], PULL_TIMEOUT_MS);
  if (err) {
    entry.error = err;
    logs.push(`Pull failed for ${entry.image}: ${err}`);
    return;
  }
  entry.pulled = true;
}

/** `fresh` mode: drop the local copy so the pull cannot be served from cache. */
async function deleteLocalImage(
  executor: Exec, nodeName: string, service: string, entry: ForceUpdateImage, logs: string[],
): Promise<void> {
  if (imageSharedWithOtherService(nodeName, entry.image, service)) {
    logs.push(`Kept local image ${entry.image} — another service is running it; re-pulling without deleting.`);
    return;
  }
  const err = await tryExec(executor, ['podman', 'rmi', '-f', entry.image], SHORT_TIMEOUT_MS);
  if (err) {
    logs.push(`Could not delete local image ${entry.image}: ${err}`);
    return;
  }
  entry.removedLocally = true;
  logs.push(`Deleted local image ${entry.image}`);
}

/** Read both digests for one image before anything is touched. */
async function initEntry(image: string, nodeName: string): Promise<ForceUpdateImage> {
  const [before, registry] = await Promise.all([
    getRunningImageDigest(image, nodeName),
    getRegistryImageDigest(image, nodeName),
  ]);
  return {
    image, before, registry, after: null,
    pulled: false, changed: false, stale: false, removedLocally: false,
  };
}

/** Re-read the local digest and settle `changed` / `stale` honestly: a digest we
 *  could not read is "unknown", never "unchanged" and never "stale". */
async function settleEntry(entry: ForceUpdateImage, nodeName: string, logs: string[]): Promise<void> {
  entry.after = await getRunningImageDigest(entry.image, nodeName);
  entry.changed = !!entry.after && entry.after !== entry.before;
  entry.stale = !!entry.after && !!entry.registry && entry.after !== entry.registry;
  if (entry.changed) logs.push(`${entry.image}: image advanced to ${entry.after}`);
  else if (entry.stale) logs.push(`${entry.image}: still on ${entry.after}, registry serves ${entry.registry}`);
  else if (entry.pulled) logs.push(`${entry.image}: already the newest image`);
}

async function stopUnit(executor: Exec, unit: string, logs: string[]): Promise<void> {
  logs.push(`Stopping ${unit}…`);
  const err = await tryExec(executor, ['systemctl', '--user', 'stop', unit], STOP_TIMEOUT_MS);
  if (err) logs.push(`Stop reported: ${err}`);
}

async function startUnit(executor: Exec, unit: string, logs: string[]): Promise<void> {
  logs.push(`Starting ${unit}…`);
  const err = await tryExec(executor, ['systemctl', '--user', '--no-block', 'start', unit], SHORT_TIMEOUT_MS);
  if (err) logs.push(`Start reported: ${err}`);
}

/**
 * Rollback anchor + trigger record (#2419). The MCP safety layer snapshots the
 * config and emails the operator before a force-update runs, but neither
 * captures WHICH image digest the service was on — and once the containers are
 * recreated the old digest lives only in the caller's response object. Record it
 * up front so the pre-update state survives in the backend log even if the
 * caller drops the report, and mirror it into `logs` so the operator sees the
 * exact `image@digest` to pin if the new image turns out to be bad.
 *
 * `warn` level on purpose: force-update is the one `lifecycle`-tier action that
 * can move a running image, so it should be visible in a default log view.
 */
function recordRollbackAnchor(
  images: ForceUpdateImage[], service: string, nodeName: string,
  mode: ForceUpdateMode, logs: string[],
): void {
  if (images.length === 0) return;
  const anchors = images.map((e) => `${e.image}@${e.before ?? 'unknown'}`).join(', ');
  logs.push(`Rollback anchor — pre-update image digests: ${anchors}`);
  logger.warn(
    'forceUpdate',
    `TRIGGERED ${service}@${nodeName} mode=${mode}; pre-update digests: ${anchors}`,
  );
}

/**
 * Force a service to re-check the registry and re-pull its image(s), then come
 * back up on the pulled image. Independent of `podman-auto-update`'s timer.
 *
 * Never throws for an individual image/container step — each is reported in the
 * result so the caller can show the operator exactly what moved and what didn't.
 * A missing service still throws (from `getServiceFiles`): that's a bad request,
 * not a partial outcome.
 */
export async function forceUpdateService(
  nodeName: string,
  serviceName: string,
  opts: { fresh?: boolean } = {},
): Promise<ForceUpdateResult> {
  const mode: ForceUpdateMode = opts.fresh ? 'fresh' : 'pull';
  const service = baseName(serviceName);
  const unit = `${service}.service`;
  const executor = getExecutor(nodeName);
  const logs: string[] = [`Force update (${mode}) for ${service} on ${nodeName}`];

  const files = await ServiceListing.getServiceFiles(nodeName, service);
  const imageRefs = collectServiceImages(files);
  const images = await Promise.all(imageRefs.map((image) => initEntry(image, nodeName)));
  let recreated: string[] = [];

  recordRollbackAnchor(images, service, nodeName, mode, logs);

  if (imageRefs.length === 0) {
    // Honest no-op: nothing to pull means nothing to force. Don't restart the
    // service to fake activity.
    logs.push('No image reference found in the service definition — nothing to pull.');
  } else if (mode === 'fresh') {
    await stopUnit(executor, unit, logs);
    recreated = await removeContainers(executor, nodeName, service, logs);
    for (const entry of images) {
      await deleteLocalImage(executor, nodeName, service, entry, logs);
      await pullOne(executor, entry, logs);
    }
    await startUnit(executor, unit, logs);
  } else {
    // Pull first: the service keeps serving while the layers download, and the
    // downtime is just the recreate.
    for (const entry of images) await pullOne(executor, entry, logs);
    await stopUnit(executor, unit, logs);
    recreated = await removeContainers(executor, nodeName, service, logs);
    await startUnit(executor, unit, logs);
  }

  for (const entry of images) await settleEntry(entry, nodeName, logs);

  const status = await ServiceListing.getServiceStatus(nodeName, service).catch(() => '');

  const result: ForceUpdateResult = {
    service, node: nodeName, mode, images, recreated,
    changed: images.some((i) => i.changed),
    stale: images.some((i) => i.stale),
    status, logs,
  };
  logger.info(
    'forceUpdate',
    `${service}@${nodeName} mode=${mode} changed=${result.changed} stale=${result.stale} images=${images.length}`,
  );
  return result;
}
