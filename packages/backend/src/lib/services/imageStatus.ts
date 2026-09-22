/**
 * Read-only answer to "is the image this service pulls actually published?" (#2995).
 *
 * An agent on this box cannot build a container image — no podman, no socket
 * (ADR 0007, correctly). Its only path from code to running service is: push,
 * let CI build and publish, then install or update. When that path breaks the
 * session has nothing left to read, and on 2026-09-20 one spent three hours
 * inventing ways to smuggle a 50 KB build into a running container. The actual
 * state was simple and knowable the whole time: **CI had never published
 * anything**, because a private repo's workflow lacked `permissions: contents:
 * read` and its checkout failed.
 *
 * `forceUpdate.ts` already reads both digests, but only while *changing* the
 * box, and `podmanDigest.ts` returns `null` for every failure alike. That null
 * is the problem this module exists to fix: "the registry does not serve this
 * tag" and "the registry was unreachable" are opposite answers — one means your
 * build never landed, the other means try again in a minute — and collapsing
 * them into `null` is what leaves a session with nothing to act on.
 *
 * So this runs the same cheap `podman manifest inspect` (a few KB, not the
 * layers) and **classifies the failure** instead of swallowing it. Nothing is
 * pulled, stopped, or recreated: it is `read`-tier, and the answer is the whole
 * product.
 */
import { ServiceListing } from './serviceListing';
import { collectServiceImages } from './forceUpdate';
import { getRunningImageDigest } from '@/lib/podmanDigest';
import { extractImageDigest } from '@/lib/updater';
import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';

const INSPECT_TIMEOUT_MS = 30 * 1000;

/**
 * Why the registry could not answer for this tag. Each maps to a different next
 * move, which is the entire reason they are not one value.
 */
export type ImageProblem =
  /** The registry answered, and has no such tag. Your build never published. */
  | 'not-published'
  /** The registry refused us. A private package, or missing pull credentials. */
  | 'unauthorized'
  /** We could not reach the registry at all. Transient; retry. */
  | 'unreachable'
  /** Something else went wrong; `detail` carries what podman said. */
  | 'unknown';

export interface ServiceImageStatus {
  /** The image ref exactly as the service definition declares it. */
  image: string;
  /** Digest the registry serves for this tag right now; null when it could not answer. */
  registry: string | null;
  /** Digest in this node's local image store; null when the image is not pulled. */
  local: string | null;
  /** The registry serves this tag. The one bit a broken CI path turns off. */
  published: boolean;
  /** The image is present locally, so the service can start from something. */
  pulled: boolean;
  /** local === registry. `null` when either digest is unknown — never guessed. */
  upToDate: boolean | null;
  /** Set only when `published` is false; says which kind of "no". */
  problem: ImageProblem | null;
  /** The registry's own words, clipped. Present only alongside `problem`. */
  detail?: string;
}

export interface ServiceImageReport {
  service: string;
  node: string;
  images: ServiceImageStatus[];
  /** Every declared image is published. False also when nothing is declared. */
  ok: boolean;
  /**
   * A sentence naming the next move, so a caller that prints nothing else still
   * prints something actionable. This is the line the smuggling evening needed.
   */
  summary: string;
}

/** Map podman's registry error onto a next move. Order matters: the auth and
 *  reachability shapes must be recognised before the generic "unknown". */
export function classifyRegistryError(message: string): { problem: ImageProblem; detail: string } {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  const m = detail.toLowerCase();
  if (/unauthorized|authentication required|denied|forbidden/.test(m)) return { problem: 'unauthorized', detail };
  if (/no such host|connection refused|i\/o timeout|dial tcp|network is unreachable|timeout|temporary failure/.test(m)) {
    return { problem: 'unreachable', detail };
  }
  if (/manifest unknown|name unknown|not found|manifest.*not known|no such (image|manifest|tag)|reference does not exist/.test(m)) {
    return { problem: 'not-published', detail };
  }
  return { problem: 'unknown', detail };
}

/** The head of a payload we could not read, flattened onto one line. Enough to
 *  recognise the shape; not so much that it drowns the message. */
function excerpt(payload: string, max = 240): string {
  const flat = payload.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty output)';
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length} chars)` : flat;
}

async function inspectRegistry(image: string, nodeName: string): Promise<Pick<ServiceImageStatus, 'registry' | 'problem' | 'detail'>> {
  try {
    const { stdout } = await getExecutor(nodeName).execSafe(
      ['podman', 'manifest', 'inspect', image],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );
    const digest = extractImageDigest(JSON.parse(stdout));
    if (digest) return { registry: digest, problem: null };
    // The registry answered with something we cannot read a digest out of.
    // Not published is the wrong word for that — and neither is "no digest
    // could be read" on its own: that sentence names the symptom and withholds
    // the one fact needed to fix it. Measured on the box, it cost a trip
    // through the registry's HTTP API to learn what podman had actually
    // returned. So the answer carries the payload it could not read.
    //
    // A manifest is public metadata — media types, digests, sizes, layer
    // references. It holds no credential, which is why quoting it here is safe
    // in a way quoting a log line would not be.
    logger.info('imageStatus', `unreadable manifest for ${image}: ${stdout.slice(0, 1000)}`);
    return {
      registry: null,
      problem: 'unknown',
      detail: `the registry answered, but no digest could be read from what podman returned: ${excerpt(stdout)}`,
    };
  } catch (e) {
    const { problem, detail } = classifyRegistryError(e instanceof Error ? e.message : String(e));
    logger.info('imageStatus', `registry inspect ${image}: ${problem} (${detail})`);
    return { registry: null, problem, detail };
  }
}

/** Turn the per-image findings into one sentence that names a next move. */
export function summarise(service: string, images: ServiceImageStatus[]): string {
  if (images.length === 0) {
    return `${service} declares no image reference — nothing is pulled from a registry, so there is no release path to check.`;
  }
  const missing = images.filter(i => i.problem === 'not-published');
  if (missing.length > 0) {
    return `The registry serves no such tag for ${missing.map(i => i.image).join(', ')}. `
      + 'Nothing was ever published under it: check that the build actually ran and pushed — a workflow whose checkout '
      + 'failed leaves exactly this state. Until a tag exists, nothing on the box can pull it.';
  }
  const refused = images.filter(i => i.problem === 'unauthorized');
  if (refused.length > 0) {
    return `The registry refused us for ${refused.map(i => i.image).join(', ')} — the package is private or this node has no pull credential for it.`;
  }
  const unreachable = images.filter(i => i.problem === 'unreachable');
  if (unreachable.length > 0) {
    return `Could not reach the registry for ${unreachable.map(i => i.image).join(', ')}; this says nothing about whether the image exists. Retry.`;
  }
  // The registry ANSWERED and we could not read what it said. Saying "could not
  // reach" there is the same conflation one level down from the one #3036
  // fixed in the rendering: a reader told the registry is unreachable retries,
  // when the thing to do is look at what it actually served.
  const unreadable = images.filter(i => i.problem === 'unknown');
  if (unreadable.length > 0) {
    return `The registry answered for ${unreadable.map(i => i.image).join(', ')}, but its manifest could not be read — `
      + 'so whether the image exists is unknown, NOT no. `podman manifest inspect <image>` on the box shows what it served.';
  }
  const behind = images.filter(i => i.upToDate === false);
  if (behind.length > 0) {
    return `Published, and ${behind.map(i => i.image).join(', ')} is behind what the registry serves — \`servicebay update ${service}\` moves it.`;
  }
  const unpulled = images.filter(i => !i.pulled);
  if (unpulled.length > 0) {
    return `Published, but not pulled on this node yet: ${unpulled.map(i => i.image).join(', ')}.`;
  }
  return `Published, pulled, and on the digest the registry serves. Nothing to do.`;
}

/**
 * What every image this service declares looks like from here: published,
 * pulled, current. Touches nothing.
 */
export async function getServiceImageStatus(nodeName: string, serviceName: string): Promise<ServiceImageReport> {
  const service = serviceName.replace(/\.(service|kube|container)$/, '');
  const files = await ServiceListing.getServiceFiles(nodeName, service);
  const refs = collectServiceImages(files);

  const images: ServiceImageStatus[] = await Promise.all(refs.map(async (image) => {
    const [reg, local] = await Promise.all([
      inspectRegistry(image, nodeName),
      getRunningImageDigest(image, nodeName),
    ]);
    const published = reg.registry !== null;
    return {
      image,
      registry: reg.registry,
      local,
      published,
      pulled: local !== null,
      // Never guessed: two known digests, or null.
      upToDate: reg.registry && local ? reg.registry === local : null,
      problem: published ? null : (reg.problem ?? 'unknown'),
      ...(reg.detail && !published ? { detail: reg.detail } : {}),
    };
  }));

  return {
    service,
    node: nodeName,
    images,
    ok: images.length > 0 && images.every(i => i.published),
    summary: summarise(service, images),
  };
}
