/**
 * What a pod spec promises that it cannot keep (#3020).
 *
 * Three deployments in two days went through with faults ServiceBay could have
 * seen at the door. Each time the tool reported success, and the truth arrived
 * hours later out of a restart counter:
 *
 *  1. A liveness probe running `curl` in `node:20-alpine`, which has no `curl`.
 *     The check can never go green, so the container restarts forever — once to
 *     **1006 restarts**, with the whole box noticeably slow and nobody
 *     connecting the two. Two days later the same fault, character for
 *     character, in the next deployment — by then with a catalog rule against
 *     it, because a rule only works when somebody opens it, and the failure
 *     case is precisely the one where a session believes it is finished.
 *  2. A 103 KB pod spec carrying the application itself as a base64 blob,
 *     because the CI-built image could not be pulled. The deploy succeeded; the
 *     real question — how does the box get its image — stayed unanswered and
 *     invisible.
 *
 * So the check moves to where the action is. This module is the pure half: it
 * reads a manifest and says what is wrong with it, with no box, no podman and
 * no I/O, which is what makes it testable against the exact shapes that shipped.
 *
 * ## Refuse vs. warn
 *
 * A finding either makes the deployment **certainly** broken or merely
 * suspicious, and the two must not be one thing. A probe binary the image
 * cannot possibly have is a refusal: there is no configuration in which that
 * container becomes healthy. An embedded blob is a warning: it is almost always
 * a workaround for a broken image path, but it is the caller's call, and
 * refusing it would block someone who genuinely means it at a moment when they
 * have no other route (#2995).
 *
 * Every finding carries the reason and the next step. `isError: true` with no
 * reason is what produces the workaround loop in the first place.
 */
import yaml from 'js-yaml';

type PreflightSeverity = 'refuse' | 'warn';

export interface PreflightFinding {
  severity: PreflightSeverity;
  /** Stable id so a caller can branch without parsing prose. */
  code: 'probe-binary-missing' | 'probe-binary-unverifiable' | 'embedded-application' | 'oversized-manifest';
  /** Where in the manifest, for a caller that wants to point at it. */
  path: string;
  /** What is wrong, and what to do about it. Written for the agent that reads it. */
  message: string;
}

/** A probe command found in the manifest, with enough context to check it. */
export interface ProbeCommand {
  container: string;
  image: string;
  /** `livenessProbe` | `readinessProbe` | `startupProbe`. */
  probe: string;
  /** The full argv of the probe's `exec.command`. */
  command: string[];
  /**
   * The binaries the command invokes that a bare image may not carry. Derived,
   * not guessed at call time, so the probe and the explanation agree.
   */
  binaries: string[];
}

/**
 * Binaries a probe commonly reaches for that a slim base image frequently
 * lacks. The list is not a policy — it decides only what is worth *checking*;
 * the image itself decides the answer. Shells are deliberately absent: `sh`
 * exists in essentially every image that can run a probe at all, and a false
 * refusal on it would be worse than the fault it looks for.
 */
const CHECKED_BINARIES = new Set(['curl', 'wget', 'nc', 'netcat', 'ncat', 'ping', 'python', 'python3', 'jq', 'redis-cli', 'pg_isready', 'mysqladmin', 'mongosh', 'httping']);

/** Shell wrappers whose ARGUMENT is the real command line. */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'ash', 'dash', 'zsh', '/bin/sh', '/bin/bash', '/bin/ash']);

/**
 * The binaries a probe command actually invokes, looking through a `sh -c`
 * wrapper. Deliberately simple: split the shell string on the operators that
 * separate commands and take each segment's first word. A missed binary is a
 * check not run; a wrongly-extracted one would be a refusal on a working
 * deployment, so the extraction only ever reports words it recognises.
 */
export function probeBinaries(command: string[]): string[] {
  if (command.length === 0) return [];
  const found = new Set<string>();

  const consider = (word: string) => {
    const bare = word.replace(/^.*\//, '').trim();
    if (CHECKED_BINARIES.has(bare)) found.add(bare);
  };

  const head = command[0];
  if (SHELL_WRAPPERS.has(head)) {
    // `sh -c '<line>'` — the line is the last argument in every form we ship.
    const line = command[command.length - 1] ?? '';
    for (const segment of line.split(/\|\||&&|[;|&]/)) {
      const first = segment.trim().split(/\s+/)[0];
      if (first) consider(first);
    }
    return [...found];
  }

  consider(head);
  return [...found];
}

/**
 * The shape this module reads out of a manifest. Deliberately partial and
 * fully optional: the manifest has already been schema-validated by the time
 * anything here runs, and re-declaring the whole Pod type would couple this
 * file to every future field.
 */
interface ProbeSpec { exec?: { command?: unknown } }
interface ContainerSpec {
  name?: unknown;
  image?: unknown;
  args?: unknown;
  command?: unknown;
  env?: unknown;
  livenessProbe?: ProbeSpec;
  readinessProbe?: ProbeSpec;
  startupProbe?: ProbeSpec;
}
interface PodDoc { kind?: unknown; spec?: { containers?: unknown } }

const PROBE_KINDS = ['livenessProbe', 'readinessProbe', 'startupProbe'] as const;

/** The Pod document's containers, or an empty list for anything unexpected. */
function podContainers(yamlContent: string): ContainerSpec[] {
  let docs: unknown[];
  try {
    docs = yaml.loadAll(yamlContent) as unknown[];
  } catch {
    return [];
  }
  const pod = docs.find((d): d is PodDoc => !!d && typeof d === 'object' && (d as PodDoc).kind === 'Pod');
  const containers = pod?.spec?.containers;
  return Array.isArray(containers) ? (containers as ContainerSpec[]) : [];
}

/** Every exec-probe in the manifest, with its container's image. */
export function collectProbeCommands(yamlContent: string): ProbeCommand[] {
  const out: ProbeCommand[] = [];
  for (const c of podContainers(yamlContent)) {
    for (const probe of PROBE_KINDS) {
      const command = c[probe]?.exec?.command;
      if (!Array.isArray(command) || command.length === 0) continue;
      const argv = command.map((x: unknown) => String(x));
      const binaries = probeBinaries(argv);
      if (binaries.length === 0) continue;
      out.push({
        container: String(c.name ?? '?'),
        image: String(c.image ?? ''),
        probe,
        command: argv,
        binaries,
      });
    }
  }
  return out;
}

/**
 * A manifest big enough, or shaped oddly enough, that the application is
 * probably inside it rather than in an image.
 *
 * The threshold is deliberately generous: a legitimate multi-container spec
 * with a long env block stays well under it, and the base64 test is what
 * actually identifies the shape. Size alone only warns when it is far past
 * anything a hand-written spec reaches.
 */
const LARGE_MANIFEST_BYTES = 24 * 1024;
/** A base64 run this long in an argument is not a token or a hash. */
const EMBEDDED_BLOB_RE = /[A-Za-z0-9+/]{512,}={0,2}/;

export function inspectManifestShape(yamlContent: string): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const bytes = Buffer.byteLength(yamlContent, 'utf8');

  for (const c of podContainers(yamlContent)) {
    const fields: [string, unknown][] = [
      ['args', c.args],
      ['command', c.command],
      ['env', c.env],
    ];
    for (const [field, value] of fields) {
      if (value === undefined || value === null) continue;
      if (!EMBEDDED_BLOB_RE.test(JSON.stringify(value))) continue;
      findings.push({
        severity: 'warn',
        code: 'embedded-application',
        path: `spec.containers[${String(c.name ?? '?')}].${field}`,
        message: `\`${field}\` carries a long base64 blob, so the application appears to be inside the pod spec rather `
          + `than in the image \`${String(c.image ?? '?')}\`. That deploys, but it means the image from your build is `
          + 'not what runs — and the next deploy, restore or restart has no way to reproduce it. If the image cannot '
          + 'be pulled, that is the thing to fix: `servicebay images <service>` says whether the registry serves the '
          + 'tag at all, and `release-check.mjs` says whether the build ever published one.',
      });
      break; // one finding per container is enough to make the point
    }
  }

  if (bytes > LARGE_MANIFEST_BYTES && !findings.some(f => f.code === 'embedded-application')) {
    findings.push({
      severity: 'warn',
      code: 'oversized-manifest',
      path: '$',
      message: `This pod spec is ${Math.round(bytes / 1024)} KB. A hand-written spec is rarely past a few KB, so `
        + 'something that belongs in an image or a mounted file is probably inlined here. Deploying works; '
        + 'reproducing it later may not.',
    });
  }
  return findings;
}

/**
 * Turn an image probe's verdict into a finding.
 *
 * `present === false` is a refusal: there is no configuration in which that
 * container becomes healthy, and letting it through buys a restart loop nobody
 * traces back. `present === null` means we could not tell (the image is not
 * pulled yet, podman refused, the probe timed out) — that is a warning, never a
 * refusal, because blocking a deploy on our own inability to check would be a
 * worse failure than the one we are looking for.
 */
export function probeFinding(probe: ProbeCommand, binary: string, present: boolean | null, detail?: string): PreflightFinding | null {
  if (present === true) return null;
  const where = `spec.containers[${probe.container}].${probe.probe}.exec.command`;
  if (present === false) {
    return {
      severity: 'refuse',
      code: 'probe-binary-missing',
      path: where,
      message: `\`${binary}\` is not present in \`${probe.image}\`, so this ${probe.probe} can never go green and the `
        + 'container will restart forever — one such deploy reached 1006 restarts before anyone connected it to the '
        + `slow box (#3020). Use a check the image can actually run (many images have none of curl/wget: a plain `
        + `\`${probe.probe.replace('Probe', '')}\` via tcpSocket, or the app's own CLI), or choose an image that carries \`${binary}\`.`,
    };
  }
  return {
    severity: 'warn',
    code: 'probe-binary-unverifiable',
    path: where,
    message: `Could not check whether \`${binary}\` exists in \`${probe.image}\`${detail ? ` (${detail})` : ''}, so this `
      + `${probe.probe} is unverified. If the binary is missing the container will restart forever with no other `
      + 'symptom — worth confirming by hand before you call the deployment done.',
  };
}

/** Does this set of findings block the deploy? */
export function refuses(findings: PreflightFinding[]): boolean {
  return findings.some(f => f.severity === 'refuse');
}

/** One message carrying every finding, refusals first. */
export function describeFindings(findings: PreflightFinding[]): string {
  const ordered = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'refuse' ? -1 : 1));
  return ordered.map(f => `[${f.severity}] ${f.path}: ${f.message}`).join('\n');
}
