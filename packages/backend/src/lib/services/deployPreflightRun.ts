/**
 * The half of the door check that needs the box (#3020).
 *
 * `deployPreflight.ts` reads the manifest and says what is suspicious. Only one
 * question cannot be answered from the text: **does this image actually carry
 * the binary the probe calls?** `podman run --rm <image> sh -c 'command -v curl'`
 * answers it in about a second, and that second buys back the 1006-restart loop
 * nobody traced to its cause.
 *
 * Three rules keep this from becoming its own failure mode:
 *
 *  - **It never pulls.** `--pull=never` — an image that is not on the node yet
 *    is "could not check", not a reason to drag a layer set over the network in
 *    the middle of a deploy. The install path pulls in its own phase anyway, so
 *    a first-time install warns and a redeploy (the case that matters, because
 *    that is where the same fault shipped twice) checks for real.
 *  - **It is capped.** A hung probe must not hang the deploy; the timeout turns
 *    into "could not check".
 *  - **It never turns our blindness into a refusal.** Only a container that
 *    RAN and reported the binary absent refuses. Everything else warns.
 */
import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';
import {
  collectProbeCommands,
  inspectManifestShape,
  probeFinding,
  type PreflightFinding,
} from './deployPreflight';

const PROBE_TIMEOUT_MS = 20 * 1000;
/** Overridden as the container's entrypoint so the image's own wrapper cannot
 *  reinterpret our arguments — the equals form leaves podman nothing to guess. */
const SHELL = 'sh';
/** podman could not give us an answer about the binary at all. */
const NOT_OUR_ANSWER = /no such image|unable to find image|image not known|pull.*never|unknown flag|executable file not found|no such file or directory/i;

/**
 * Is `binary` on PATH inside `image`?
 *
 * `true` / `false` only when the container ran and answered; `null` for every
 * other outcome, with the reason, so the caller can say why it could not tell.
 */
export async function binaryInImage(
  nodeName: string,
  image: string,
  binary: string,
): Promise<{ present: boolean | null; detail?: string }> {
  try {
    // Through `execSafe`, like every other exec on this path. The first cut
    // called `sendCommand('safe_exec', …)` directly, which worked but wrote no
    // `safe_exec:` audit line — so when the check failed to fire on the box
    // there was nothing in the journal to look at, and the fault could not be
    // told apart from the check never running (#3020 follow-up).
    const res = await getExecutor(nodeName).execSafe(
      ['podman', 'run', '--rm', '--pull=never', `--entrypoint=${SHELL}`, image, '-c', `command -v ${binary}`],
      { timeoutMs: PROBE_TIMEOUT_MS, check: false },
    );
    const stdout = (res.stdout ?? '').trim();
    const stderr = (res.stderr ?? '').trim();

    // `command -v` PRINTS THE PATH when it finds the binary. An exit 0 with no
    // path means something other than our shell ran — an image whose entrypoint
    // swallowed the arguments, a wrapper that lost the real exit code. Reading
    // that as "present" is exactly how a check reports success for something it
    // never established, so it is `unknown` instead.
    if (res.code === 0) {
      return stdout
        ? { present: true }
        : { present: null, detail: 'the probe exited 0 but printed no path, so nothing was actually established' };
    }
    // The image is not on this node, or podman could not start it at all —
    // that says nothing about the binary.
    if (NOT_OUR_ANSWER.test(stderr)) {
      return { present: null, detail: stderr.slice(0, 160) || `podman exit ${res.code}` };
    }
    // `command -v` exits 1 when the binary is absent. The container ran; this
    // is a real answer.
    if (res.code === 1) return { present: false };
    return { present: null, detail: stderr.slice(0, 160) || `podman exit ${res.code}` };
  } catch (e) {
    return { present: null, detail: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

/**
 * Everything wrong with this manifest that can be known before it is written.
 *
 * Never throws: a preflight that blows up must not take the deploy with it. A
 * failure to check is reported as a failure to check.
 */
export async function preflightDeployment(
  nodeName: string,
  yamlContent: string,
  onProgress?: (message: string) => void,
  deps: { check?: typeof binaryInImage } = {},
): Promise<PreflightFinding[]> {
  const check = deps.check ?? binaryInImage;
  const findings: PreflightFinding[] = [];

  try {
    findings.push(...inspectManifestShape(yamlContent));

    const probes = collectProbeCommands(yamlContent);
    for (const probe of probes) {
      if (!probe.image) continue;
      for (const binary of probe.binaries) {
        const { present, detail } = await check(nodeName, probe.image, binary);
        const finding = probeFinding(probe, binary, present, detail);
        if (finding) findings.push(finding);
      }
    }
    if (probes.length > 0) {
      onProgress?.(`Checked ${probes.length} health probe(s) against their images.`);
    }
  } catch (e) {
    // The check itself broke. Say so; do not let it decide the deploy.
    logger.warn('deployPreflight', `Preflight checks could not run: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const f of findings) {
    logger[f.severity === 'refuse' ? 'error' : 'warn']('deployPreflight', `${f.severity}: ${f.path}: ${f.message}`);
    onProgress?.(`${f.severity === 'refuse' ? '✖' : '⚠'} ${f.message}`);
  }
  return findings;
}
