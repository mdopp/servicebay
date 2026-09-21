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
import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import {
  collectProbeCommands,
  inspectManifestShape,
  probeFinding,
  type PreflightFinding,
} from './deployPreflight';

const PROBE_TIMEOUT_MS = 20 * 1000;

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
    // The same door the rest of the deploy path goes through
    // (`agentManager.ensureAgent`), not a second executor: a preflight that
    // reaches the node by a different route is a preflight that can be absent
    // exactly where the deploy is present.
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand(
      'safe_exec',
      { argv: ['podman', 'run', '--rm', '--pull=never', '--entrypoint', 'sh', '--', image, '-c', `command -v ${binary}`] },
      { timeoutMs: PROBE_TIMEOUT_MS },
    ) as { code?: number; stdout?: string; stderr?: string };
    if (res.code === 0) return { present: true };
    const stderr = (res.stderr ?? '').trim();
    // The image is not on this node, or podman could not start it at all —
    // that says nothing about the binary.
    if (/no such image|unable to find image|image not known|pull.*never|unknown flag|no such file or directory.*sh/i.test(stderr)) {
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
