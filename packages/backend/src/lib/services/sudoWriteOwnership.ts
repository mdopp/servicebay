/**
 * Making a sudo-written file owned by whoever has to read it (#1298, #2717, #3044).
 *
 * `sudo tee` lands a file owned by **host root**, and a rootless container
 * cannot do anything with that: outside its user namespace the uid is not
 * mapped, so its own `chown` fails with EPERM and podman's volume relabel
 * cannot `lsetxattr` the path either.
 *
 * On 2026-09-26 that took the entire reverse proxy down. NPM chowns its data
 * volume on startup, hit six root-owned `forward-auth-denied-*.html` pages
 * ServiceBay had written there, exited 1 out of its `prepare` step, and 24 of
 * 24 domains went unreachable. The pages were correct; only their owner was
 * wrong.
 *
 * The repair was already written for the install transport and lived private
 * to it, so the second sudo writer never got it — the same drift that put an
 * unhardened twin beside a hardened one all week. It lives here now, and both
 * callers use it.
 *
 * The owner is DERIVED, never assumed: `chown --reference=<nearest ancestor
 * that is not root-owned>`. Hard-coding `core:core` would be wrong for a pod
 * running as some other mapped uid, and the reference is the only thing that
 * knows which that is.
 */
import { logger } from '@/lib/logger';

/**
 * Shell-quote one argument, ALWAYS wrapping. Deliberately not
 * `lib/util/shellQuote`, which quotes only when it judges quoting necessary:
 * these commands are pinned character-for-character by the tests that guard
 * them, and swapping the quoting style would be an unrelated change riding
 * along inside an ownership fix.
 */
function shellQuote(p: string): string {
    return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Anything that can talk to a node. Kept structural so both callers fit. */
export interface FileWritingAgent {
    sendCommand(action: string, params?: unknown): Promise<unknown>;
}

/** Best-effort stdout of an agent `exec` reply, whatever shape it arrives in. */
export function extractStdout(res: unknown): string | null {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'stdout' in res) {
        const out = (res as { stdout?: unknown }).stdout;
        if (typeof out === 'string') return out;
    }
    return null;
}

// ── #1298 / #2717: ownership of what the sudo write path leaves behind ──
//
// A sudo write lands its file — and, in the agent's `write_file` sudo
// branch, its `sudo mkdir -p` parent chain — owned by **root**. The only
// reason the unprivileged write failed in the first place is that the asset
// dir belongs to the consuming rootless pod's mapped uid, and a root-owned
// path inside it breaks that pod's next `podman kube play --replace`:
// rootless podman cannot `lsetxattr` a path it does not own, so the volume
// relabel fails and the pod will not restart.
//
// #1298 fixed the FILE by chowning it `--reference=<its parent dir>`. #2717
// is the same failure one level up and is exactly what that reference
// cannot see: when the file lands in a **newly created** subdirectory
// (a new skill dir under a shared `skills/` hostPath), the sudo write
// created that directory as root too — so `--reference=<dir>` resolves to
// root:root and the chown is a no-op. Podman then failed on the DIRECTORY,
// not on the file:
//
//   lsetxattr(...) /mnt/data/stacks/solaris/skills/household/task-tool: operation not permitted
//
// So the reference must be the nearest ancestor that is **not root-owned**
// (the uid the siblings already carry), and the repair set must be every
// path from below that ancestor down to the file — which also heals a
// directory left root-owned by an earlier deploy, since the walk skips past
// it instead of adopting its ownership.

/** Marker the ownership probe prints its answer behind. */
const OWNER_REF_MARKER = 'sb-owner-ref:';

/**
 * Minimum depth for an ownership reference, mirroring
 * {@link isPrunableDeliveryPath}: everything this transport writes lives at
 * `<dataDir>/<service>/…`, so a reference shallower than three segments means
 * the walk left the service's own tree and the repair is declined rather than
 * chowning a shared parent.
 */
const MIN_OWNER_REF_SEGMENTS = 3;

/** Strip trailing slashes, keeping `/` itself. */
function normalizeDir(p: string): string {
    return p.replace(/\/+$/, '') || '/';
}

/**
 * The ownership reference reported by the probe, or `null` when it is
 * unusable. Pure — the decision to decline the repair is testable without a
 * node.
 *
 * Declines an answer that is not absolute, is shallower than
 * {@link MIN_OWNER_REF_SEGMENTS}, or is not an ancestor of `dir` (a garbled
 * reply must never become a `chown --reference` target).
 */
export function parseOwnerReference(stdout: string | null, dir: string): string | null {
    if (!stdout) return null;
    const line = stdout.split('\n').map(s => s.trim()).find(l => l.startsWith(OWNER_REF_MARKER));
    if (!line) return null;
    const ref = normalizeDir(line.slice(OWNER_REF_MARKER.length).trim());
    if (!ref.startsWith('/')) return null;
    if (ref.split('/').filter(Boolean).length < MIN_OWNER_REF_SEGMENTS) return null;
    const target = normalizeDir(dir);
    if (target !== ref && !target.startsWith(`${ref}/`)) return null;
    return ref;
}

/**
 * Every path a sudo write may have left root-owned: each directory from the
 * one just below `reference` down to `dir`, then the file itself. Pure, so
 * the repair set is provable without a box.
 *
 * `reference === dir` (the directory already existed and is properly owned)
 * yields just the file — the #1298 case, unchanged.
 */
export function ownershipRepairTargets(reference: string, dir: string, filePath: string): string[] {
    const ref = normalizeDir(reference);
    const target = normalizeDir(dir);
    const targets: string[] = [];
    if (target !== ref && target.startsWith(`${ref}/`)) {
        let cur = ref === '/' ? '' : ref;
        for (const seg of target.slice(ref === '/' ? 1 : ref.length + 1).split('/').filter(Boolean)) {
            cur = `${cur}/${seg}`;
            targets.push(cur);
        }
    }
    targets.push(filePath);
    return targets;
}

/**
 * Create `dir` and, in the SAME round trip, report the nearest ancestor that
 * exists and is not root-owned — probed **before** the `mkdir`, because the
 * mkdir is one of the things that can create a root-owned directory.
 *
 * Returns `null` when no usable reference came back; the caller then falls
 * back to the pre-#2717 file-only repair rather than guessing an owner.
 */
export async function ensureDirAndProbeOwner(agent: FileWritingAgent, dir: string): Promise<string | null> {
    const q = shellQuote(dir);
    const command =
        `ref=${q}; ` +
        `while [ "$ref" != / ]; do ` +
        `if [ -d "$ref" ] && [ "$(stat -c %u "$ref" 2>/dev/null)" != 0 ]; then break; fi; ` +
        `ref=$(dirname "$ref"); ` +
        `done; ` +
        `printf '${OWNER_REF_MARKER}%s\\n' "$ref"; ` +
        `mkdir -p ${q}`;
    // A failing exec propagates exactly as the bare `mkdir -p` did before.
    const res = await agent.sendCommand('exec', { command });
    const ref = parseOwnerReference(extractStdout(res), dir);
    if (!ref) {
        logger.warn('sudoWriteOwnership', `Could not determine a non-root ownership reference for ${dir}; a sudo write there will only realign the file itself.`);
    }
    return ref;
}

/**
 * Realign what the sudo write left root-owned so a later rootless
 * `kube play --replace` relabel of the asset dir can still lsetxattr it.
 *
 * Best-effort: the file is already written and an ownership mismatch only
 * bites a later relabel, so a chown failure is logged, never fatal.
 */
export async function realignSudoWrite(
    agent: FileWritingAgent,
    filePath: string,
    dir: string,
    ownerRef: string | null,
): Promise<void> {
    const reference = ownerRef ?? dir;
    const targets = ownerRef ? ownershipRepairTargets(ownerRef, dir, filePath) : [filePath];
    const command = `sudo chown --reference=${shellQuote(reference)} -- ${targets.map(shellQuote).join(' ')}`;
    try {
        const res = await agent.sendCommand('exec', { command });
        if (res && typeof res === 'object' && 'code' in res && (res as { code: unknown }).code !== 0) {
            logger.warn('sudoWriteOwnership', `chown to match ${reference} owner failed for ${targets.join(', ')}: ${JSON.stringify(res)}`);
        }
    } catch (err) {
        logger.warn('sudoWriteOwnership', `chown to match ${reference} owner failed for ${targets.join(', ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

