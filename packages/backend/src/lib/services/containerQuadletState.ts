/**
 * "Is the container that is actually running the one the `.container` Quadlet
 * currently describes?" — the judgement that decides whether the #2174 shadow
 * reconcile has to force-recreate the container, or may leave it alone (#2618).
 *
 * Why this is not a file diff. `reconcileContainerQuadletShadow` used to
 * force-recreate on *every* deploy of a `.container` service. For ollama that
 * silently evicted the VRAM-resident models on each install — the whole point
 * of `OLLAMA_KEEP_ALIVE`/`OLLAMA_MAX_LOADED_MODELS` — and the reload costs
 * minutes of a user staring at nothing. But the opposite error is worse: skip a
 * recreate that was needed and the box keeps serving a container built from
 * config nobody is running any more, while the install reports success. So the
 * comparison must be strong evidence, not a heuristic.
 *
 * The evidence used here is the `podman run` argv on both sides:
 *
 *   desired  = the `ExecStart=` argv of the *currently generated*
 *              `<name>.service` (`systemctl show`, after `daemon-reload`).
 *              podman's quadlet generator produced it from the `.container`
 *              file that is on disk right now, and systemd has already expanded
 *              its `%t`/`%N` specifiers.
 *   actual   = `podman inspect .Config.CreateCommand` of the running container
 *              — the argv that actually created it.
 *
 * Equal argv means the running container was created by an identical
 * `podman run` invocation to the one systemd would issue now. That comparison
 * is immune to the churn a re-render produces, *by construction*, because the
 * generator — not this code — does the normalising: it drops comments and blank
 * lines entirely, and it emits `--env` flags sorted. (Box-observed on the real
 * ollama unit: the file lists `OLLAMA_HOST`, `…CONTEXT_LENGTH`, `…KEEP_ALIVE`,
 * `…MAX_LOADED_MODELS`, `…FLASH_ATTENTION`, while the generated ExecStart
 * carries them alphabetically.) A file rewritten with identical content, or
 * with only comment/whitespace/ordering churn, therefore yields byte-identical
 * argv and no recreate.
 *
 * Everything the argv does *not* cover is handled by erring toward recreating:
 * the image is compared by id as well (so a moved `:latest` still recreates),
 * and every unknown — unreadable ExecStart, quoted argv this cannot tokenise
 * unambiguously, a container podman has no `CreateCommand` for, an inactive
 * unit, any inspect failure — returns `recreate: true`. The skip is only taken
 * on positive proof; every doubt costs a restart, never a stale container.
 */

/** What the `.container` unit + the systemd generator say should be running. */
export interface DesiredContainerState {
    /** `ExecStart=` argv of the generated unit, or `null` if unreadable. */
    execStartArgv: string[] | null;
    /** Image id `Image=` currently resolves to on the box, `''` if unresolved. */
    imageId: string;
}

/** What `podman inspect` says about the container that is actually there. */
export interface RunningContainerState {
    running: boolean;
    /** Image id the running container was created from. */
    imageId: string;
    /** `.Config.CreateCommand` — the argv that created it. */
    createCommand: string[] | null;
}

export interface RecreateDecision {
    recreate: boolean;
    /** Human-readable, logged verbatim into the install log. */
    reason: string;
}

/** podman/systemd names we are willing to interpolate into a shell command. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export function isSafeShellName(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.length > 0 && value.length < 256 && SAFE_NAME.test(value);
}

/**
 * First value of a systemd unit directive (`Image=`, `ContainerName=`, …).
 * Comment lines and indentation are ignored; `null` when the key is absent.
 */
export function readUnitDirective(unitContent: string, key: string): string | null {
    for (const raw of (unitContent ?? '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (!line.startsWith(`${key}=`)) continue;
        const value = line.slice(key.length + 1).trim();
        if (value) return value;
    }
    return null;
}

/**
 * The container name a `.container` unit produces: its explicit
 * `ContainerName=`, else quadlet's default `systemd-<unit>`.
 */
export function containerNameForQuadlet(serviceName: string, unitContent: string): string {
    return readUnitDirective(unitContent, 'ContainerName') ?? `systemd-${serviceName}`;
}

/**
 * argv out of `systemctl show <unit> --property=ExecStart`, whose one line
 * reads `ExecStart={ path=… ; argv[]=… ; ignore_errors=… ; … }`.
 *
 * Returns `null` — meaning "unknown", i.e. recreate — for anything this cannot
 * read unambiguously: no/empty ExecStart, more than one ExecStart line, or
 * quoted arguments (systemd's flat `argv[]=` rendering cannot be re-tokenised
 * without guessing, and a wrong guess must never look like a match).
 */
export function parseExecStartArgv(showOutput: string): string[] | null {
    const lines = (showOutput ?? '').split('\n').filter(l => l.startsWith('ExecStart='));
    if (lines.length !== 1) return null;
    const line = lines[0];
    const at = line.indexOf('argv[]=');
    if (at < 0) return null;
    const end = line.indexOf(' ; ', at);
    if (end < 0) return null;
    const raw = line.slice(at + 'argv[]='.length, end).trim();
    if (!raw) return null;
    if (raw.includes('"') || raw.includes("'") || raw.includes('\\')) return null;
    return raw.split(/\s+/);
}

/**
 * Parse the single-line `running|imageId|createCommandJson` probe. `null` when
 * the container is absent or podman answered in a shape we don't recognise.
 */
export function parseInspectFacts(stdout: string): RunningContainerState | null {
    const line = (stdout ?? '').trim().split('\n').filter(Boolean).pop();
    if (!line) return null;
    const first = line.indexOf('|');
    const second = line.indexOf('|', first + 1);
    if (first < 0 || second < 0) return null;
    const running = line.slice(0, first).trim() === 'true';
    const imageId = line.slice(first + 1, second).trim();
    let createCommand: string[] | null = null;
    try {
        const parsed: unknown = JSON.parse(line.slice(second + 1).trim());
        if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) {
            createCommand = parsed as string[];
        }
    } catch { /* not JSON → unknown → the caller recreates */ }
    return { running, imageId, createCommand };
}

function argvEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The decision itself. Skips the recreate only on positive proof that the
 * running container came from exactly this unit and this image; every other
 * outcome — including every "can't tell" — recreates.
 */
export function decideContainerRecreate(input: {
    desired: DesiredContainerState;
    running: RunningContainerState | null;
    unitActive: boolean;
}): RecreateDecision {
    const { desired, running, unitActive } = input;

    if (!unitActive) return { recreate: true, reason: 'the unit is not active' };
    // Absent container, or a podman that answered in a shape this cannot read
    // (e.g. no `.Config.CreateCommand`) — both are "can't tell", both recreate.
    if (!running) return { recreate: true, reason: 'podman did not identify a running container for this unit' };
    if (!running.running) return { recreate: true, reason: 'the container exists but is not running' };
    if (!desired.execStartArgv || desired.execStartArgv.length === 0) {
        return { recreate: true, reason: "the unit's resolved ExecStart could not be read" };
    }
    if (!running.createCommand || running.createCommand.length === 0) {
        return { recreate: true, reason: 'podman does not record how the running container was created' };
    }
    if (!argvEqual(desired.execStartArgv, running.createCommand)) {
        return { recreate: true, reason: 'the .container Quadlet changed — the running container was created by a different podman run command' };
    }
    if (!desired.imageId || !running.imageId) {
        return { recreate: true, reason: "the unit's image id could not be resolved" };
    }
    if (desired.imageId !== running.imageId) {
        return { recreate: true, reason: 'a newer image for this unit is on the box than the running container was built from' };
    }
    return {
        recreate: false,
        reason: 'the running container was created by exactly this unit\'s podman run command, from the same image, and is up',
    };
}
