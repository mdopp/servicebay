/**
 * Shipping a template's rendered companion config + asset files to a node.
 *
 * Extracted from `serviceLifecycle.ts` (#2590) — that module was at its
 * size ceiling and this is a self-contained concern: one agent-facing
 * write loop plus the rules about WHICH files a deploy may write.
 *
 * The central rule, and the reason this file exists as its own unit: a
 * deploy re-renders and rewrites every companion config file, which is
 * correct for a file ServiceBay owns and destructive for a file the
 * running application owns (ADR 0004 — installs are non-destructive).
 * Templates mark the latter with `servicebay.seed-only-configs`; those
 * are written only when the node reports them absent.
 *
 * #2703 — the same transport had no deletion concept at all: a file removed
 * from a template's source tree stayed on the node forever, so a retired
 * skill kept declaring a live command the template could no longer take
 * back. The fix is a *delivered-files manifest*, not a mirroring sync:
 * runtime-created files (a resident's notes, `solaris.db`, a
 * `.paperless-token`) live in the very same directories, and an exclusion
 * list would be incomplete again with every new one — with a deleted user
 * file as its failure mode. So this module deletes ONLY paths it recorded
 * itself as having delivered on an earlier deploy. A path that was never
 * written by this mechanism is not a delete candidate by construction.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { logger } from '../logger';
import { DATA_DIR } from '../dirs';
import { HostFilePath } from '../api/schemas';

/** Minimal agent shape needed to ship files to a node. */
interface FileWritingAgent {
    sendCommand(action: string, params?: unknown): Promise<unknown>;
}

/** Best-effort stdout of an agent `exec` reply, whatever shape it arrives in. */
function extractStdout(res: unknown): string | null {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'stdout' in res) {
        const out = (res as { stdout: unknown }).stdout;
        if (typeof out === 'string') return out;
    }
    return null;
}

/**
 * #2590 — does a seed-only target already exist on the node?
 *
 * FAIL-CLOSED: an unreadable / unexpected / throwing probe answers "yes, it
 * exists", so the deploy skips the write. The two outcomes are not symmetric.
 * Wrongly skipping a seed leaves a companion file absent — recoverable, and
 * for the Home Assistant includes the pre-start hook (`runHomeAssistantHook`)
 * seeds it a moment later anyway. Wrongly writing destroys operator content
 * that may exist nowhere else, silently, which is the incident this guard
 * exists to prevent. Only a probe that positively reports "absent" earns a
 * write.
 */
async function seedTargetExists(agent: FileWritingAgent, path: string): Promise<boolean> {
    let raw: string | null;
    try {
        // `&& … || …` so the command exits 0 either way — a non-zero exit
        // would be indistinguishable from a transport failure here.
        raw = extractStdout(await agent.sendCommand('exec', {
            command: `test -e ${path} && echo sb-present || echo sb-absent`,
        }));
    } catch (err) {
        logger.warn('ServiceManager', `Seed-only existence probe for ${path} failed (${err instanceof Error ? err.message : String(err)}); treating the file as present and NOT writing it.`);
        return true;
    }
    const answer = raw?.trim();
    if (answer === 'sb-absent') return false;
    if (answer === 'sb-present') return true;
    logger.warn('ServiceManager', `Seed-only existence probe for ${path} returned an unexpected reply (${JSON.stringify(raw)}); treating the file as present and NOT writing it.`);
    return true;
}

/**
 * #2590 — is `path` a seed-only target that must be left as it is? True means
 * "declared seed-only AND already on the node", i.e. the deploy skips it
 * entirely. False means either the template never declared it, or it is
 * genuinely absent and this deploy gets to seed it once.
 */
async function skipAsSeedOnly(
    agent: FileWritingAgent,
    path: string,
    seedOnlyFilenames: ReadonlySet<string>,
): Promise<boolean> {
    if (seedOnlyFilenames.size === 0) return false;
    if (!seedOnlyFilenames.has(path.substring(path.lastIndexOf('/') + 1))) return false;
    if (await seedTargetExists(agent, path)) {
        logger.info('ServiceManager', `Seed-only config ${path} already exists — leaving it untouched (its content belongs to the service/operator, not to the template).`);
        return true;
    }
    logger.info('ServiceManager', `Seed-only config ${path} is absent — seeding it once.`);
    return false;
}

/**
 * One `write_file` attempt. Returns 'ok' on success, otherwise the failure
 * reason as a string — covering both the rejection (agent error reply) and
 * the defensive non-'ok' return value cases.
 */
async function attemptWrite(
    agent: FileWritingAgent,
    target: { path: string; content: string },
    sudo: boolean,
): Promise<string> {
    try {
        const res = await agent.sendCommand('write_file', { path: target.path, content: target.content, ...(sudo ? { sudo: true } : {}) });
        return res === 'ok' ? 'ok' : JSON.stringify(res);
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
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
async function ensureDirAndProbeOwner(agent: FileWritingAgent, dir: string): Promise<string | null> {
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
        logger.warn('ServiceManager', `Could not determine a non-root ownership reference for ${dir}; a sudo write there will only realign the file itself.`);
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
async function realignSudoWrite(
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
            logger.warn('ServiceManager', `chown to match ${reference} owner failed for ${targets.join(', ')}: ${JSON.stringify(res)}`);
        }
    } catch (err) {
        logger.warn('ServiceManager', `chown to match ${reference} owner failed for ${targets.join(', ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ── #2703: the delivered-files manifest ─────────────────────────────────
//
// Design priority, and it is the inverse of the obvious one: not "delete as
// completely as possible, then add exceptions", but "delete only what was
// demonstrably delivered". The manifest is the whole of the delete
// authority — nothing else is ever consulted, in particular never a live
// directory listing, because a listing cannot tell a stale template file
// from a file the running application created five minutes ago.

/** Schema version of the on-disk manifest; a mismatch is read as "absent". */
const DELIVERY_MANIFEST_VERSION = 1;

/** Manifests live in ServiceBay's own data dir, keyed by node + service. */
const DELIVERY_MANIFEST_DIR = 'delivered-files';

interface DeliveryManifest {
    version: number;
    node: string;
    service: string;
    updatedAt: string;
    paths: string[];
}

/** Filesystem-safe key for a (node, service) pair. */
function manifestKey(nodeName: string, serviceName: string): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
    return `${safe(nodeName)}__${safe(serviceName)}.json`;
}

function manifestFilePath(nodeName: string, serviceName: string): string {
    return path.join(DATA_DIR, DELIVERY_MANIFEST_DIR, manifestKey(nodeName, serviceName));
}

/**
 * Is `p` a path this module is allowed to delete?
 *
 * Deliberately the SAME rule the boundary applies to a write target
 * (`HostFilePath`): absolute, no `..` segment, no shell metacharacter. A
 * recorded path that would not be accepted as a write target today cannot
 * have been written by this mechanism under today's rules, so it is
 * reported and kept rather than removed. The depth floor is a second
 * backstop — every path this transport writes lives at
 * `<dataDir>/<service>/…`, so a two-segment path is never one of ours.
 */
export function isPrunableDeliveryPath(p: unknown): p is string {
    if (typeof p !== 'string') return false;
    if (!HostFilePath.safeParse(p).success) return false;
    return p.split('/').filter(Boolean).length >= 3;
}

/**
 * The stale set: recorded by an earlier deploy, absent from this one.
 *
 * Pure, and the only place the delete set is decided — a path absent from
 * `prior` is never a candidate no matter what else is true of it.
 */
export function selectStaleDeliveries(
    prior: readonly string[],
    delivered: ReadonlySet<string>,
): { deletable: string[]; refused: string[] } {
    const deletable: string[] = [];
    const refused: string[] = [];
    for (const p of prior) {
        if (delivered.has(p)) continue;
        if (isPrunableDeliveryPath(p)) deletable.push(p);
        else refused.push(String(p));
    }
    return { deletable, refused };
}

/**
 * Read the manifest an earlier deploy left for this (node, service).
 *
 * Returns `null` for "no usable record", which every caller must read as
 * **delete nothing** — absent, unreadable, malformed and
 * wrong-version all collapse to the same fail-safe answer.
 */
async function readDeliveryManifest(nodeName: string, serviceName: string): Promise<string[] | null> {
    const file = manifestFilePath(nodeName, serviceName);
    let raw: string;
    try {
        raw = await fs.readFile(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            logger.warn('ServiceManager', `Could not read the delivered-files manifest ${file} (${err instanceof Error ? err.message : String(err)}); this deploy will not delete anything.`);
        }
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<DeliveryManifest>;
        if (parsed?.version !== DELIVERY_MANIFEST_VERSION || !Array.isArray(parsed.paths)) {
            logger.warn('ServiceManager', `Delivered-files manifest ${file} is not version ${DELIVERY_MANIFEST_VERSION} — ignoring it; this deploy will not delete anything.`);
            return null;
        }
        return parsed.paths.filter((p): p is string => typeof p === 'string');
    } catch (err) {
        logger.warn('ServiceManager', `Delivered-files manifest ${file} is unparseable (${err instanceof Error ? err.message : String(err)}); this deploy will not delete anything.`);
        return null;
    }
}

/** Persist the manifest. A failure is logged, never fatal — the files are written. */
async function writeDeliveryManifest(nodeName: string, serviceName: string, paths: string[]): Promise<void> {
    const file = manifestFilePath(nodeName, serviceName);
    const body: DeliveryManifest = {
        version: DELIVERY_MANIFEST_VERSION,
        node: nodeName,
        service: serviceName,
        updatedAt: new Date().toISOString(),
        paths,
    };
    try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
        await fs.rename(tmp, file);
    } catch (err) {
        logger.warn('ServiceManager', `Could not persist the delivered-files manifest ${file} (${err instanceof Error ? err.message : String(err)}); the next deploy will treat this service as unrecorded and delete nothing.`);
    }
}

/** Shell-quote a single argument. */
function shellQuote(p: string): string {
    return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Delete ONE recorded path on the node. Targeted `rm -f` on exactly that
 * path — never a directory-wide `rm -rf`, never an `rsync --delete` of the
 * asset dir, because those two forms cannot distinguish a stale template
 * file from the resident's notes sitting beside it.
 *
 * Returns false when the path could not be removed; the caller keeps it in
 * the manifest so a later deploy retries instead of forgetting it.
 */
async function removeDeliveredFile(agent: FileWritingAgent, target: string): Promise<boolean> {
    const attempt = async (sudo: boolean): Promise<boolean> => {
        const res = await agent.sendCommand('exec', {
            command: `${sudo ? 'sudo ' : ''}rm -f -- ${shellQuote(target)}`,
        });
        if (res && typeof res === 'object' && 'code' in res) {
            return (res as { code: unknown }).code === 0;
        }
        return true;
    };
    try {
        if (await attempt(false)) return true;
    } catch (err) {
        logger.warn('ServiceManager', `rm of stale delivered file ${target} failed (${err instanceof Error ? err.message : String(err)}); retrying with sudo.`);
    }
    // #1171 — an asset dir can be owned by the consuming rootless pod's
    // subuid, so the unprivileged rm EACCESes exactly where the write did.
    try {
        return await attempt(true);
    } catch (err) {
        logger.warn('ServiceManager', `sudo rm of stale delivered file ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * Diff this deploy's delivered set against the previous one, delete what
 * this mechanism itself delivered and no longer delivers, and record the
 * new set.
 *
 * Three refusals are load-bearing:
 *
 *  1. **No prior manifest ⇒ delete nothing.** On the first deploy after
 *     this ships, an existing install has no record for anything already on
 *     disk. Treating that as "everything not in the source was delivered"
 *     is `--delete` wearing a different hat and would take `solaris.db`
 *     with it. So the bootstrap deploy only *records*; files orphaned by
 *     earlier deploys stay until an operator removes them (the log line
 *     says so).
 *  2. **An empty delivery never empties a non-empty manifest.** Template
 *     resolution degrades to `[]` on error (`resolveTemplateArtifacts`
 *     catches), so "this template delivers no files at all" is far more
 *     often a failed registry read than a real removal of everything.
 *  3. **Seed-only paths are never recorded** (see `writeExtraConfigFiles`),
 *     so a template that drops a seed-only declaration cannot delete the
 *     operator content that file holds.
 */
async function reconcileDeliveryManifest(
    agent: FileWritingAgent,
    nodeName: string,
    serviceName: string,
    delivered: readonly string[],
): Promise<void> {
    const prior = await readDeliveryManifest(nodeName, serviceName);
    const deliveredSet = new Set(delivered);

    if (prior === null) {
        if (delivered.length === 0) return; // nothing delivered, nothing to record
        logger.info('ServiceManager', `No delivered-files manifest for "${serviceName}" yet — recording ${delivered.length} delivered path(s). Files left on the node by deploys made before this record existed are NOT pruned: they were never recorded as delivered, and deleting an unrecorded path is exactly the mistake this manifest exists to prevent. Removing such an orphan is a deliberate operator step.`);
        await writeDeliveryManifest(nodeName, serviceName, [...deliveredSet].sort());
        return;
    }

    const { deletable, refused } = selectStaleDeliveries(prior, deliveredSet);
    if (refused.length > 0) {
        logger.warn('ServiceManager', `Delivered-files manifest for "${serviceName}" holds ${refused.length} path(s) that are not valid delete targets — keeping them recorded and NOT deleting them: ${refused.join(', ')}`);
    }

    if (deletable.length > 0 && deliveredSet.size === 0) {
        logger.warn('ServiceManager', `Deploy of "${serviceName}" delivered no files at all while ${deletable.length} path(s) are recorded as delivered. That is far more likely a failed template resolution than an intentional removal of everything, so nothing is deleted and the manifest is kept as it is.`);
        return;
    }

    const kept: string[] = [...refused];
    for (const target of deletable) {
        if (await removeDeliveredFile(agent, target)) {
            logger.info('ServiceManager', `Deleted ${target} — it was delivered by an earlier deploy of "${serviceName}" and is no longer part of the template.`);
        } else {
            kept.push(target);
            logger.warn('ServiceManager', `Could not delete stale delivered file ${target}; keeping it in the manifest so the next deploy retries.`);
        }
    }

    await writeDeliveryManifest(nodeName, serviceName, [...new Set([...deliveredSet, ...kept])].sort());
}

/** Optional per-deploy behaviour for {@link writeExtraConfigFiles}. */
export interface ExtraConfigFileOptions {
    /** Node the files are being written to — the manifest is keyed by it. */
    nodeName?: string;
    /**
     * Does `extraFiles` carry the template's COMPLETE resolved artifact set?
     *
     * Only then may this deploy conclude that a recorded path is stale.
     * Default `false`, because most callers legitimately deliver a subset:
     * `update_service_yaml` passes no files at all, and a hand-rolled
     * `deploy_service` may pass one config file for a template that also
     * ships a skills tree. Reading a subset as "everything that still
     * exists" would delete the rest — a deletion in doubt, which is the one
     * outcome this design refuses.
     */
    completeDelivery?: boolean;
}

/**
 * Write a template's rendered config + asset files to the node, creating
 * parent dirs first.
 *
 * Failures are FATAL — the previous behaviour was to log a warning and
 * continue, which produced the radicale crash-loop class of bug: the
 * service starts, finds its config file missing, dies, and the operator
 * has no breadcrumb back to the silent write_file failure during deploy.
 * Throwing surfaces the problem at deploy time with a useful path.
 *
 * #1171 — a write target can sit under a hostPath pre-provisioned by a
 * consumer container (owned by its uid, not the agent's `core`/uid-1000),
 * e.g. the asset-transport `skills/` dir on a volume the hermes/syncthing
 * pod created. The plain write EACCESes there, so a failed write is
 * retried once via the agent's #1000 privileged path (`core` has
 * passwordless sudo on FCoS) before being recorded as a failure.
 *
 * #1258 — the agent rejects (the promise throws) when a command replies
 * with an error, e.g. the EACCES above. The retry therefore has to catch
 * the thrown error, not inspect a returned value — the original `res !==
 * 'ok'` check never fired because the await threw first, so the raw
 * `[Errno 13]` propagated straight to the deploy loop and the sudo retry
 * was dead code.
 *
 * #1298 / #2717 — a sudo write lands the new file (and any parent directory
 * its own `sudo mkdir -p` had to create) owned by root, which breaks the
 * consuming pod's next `kube play --replace` relabel. After a sudo write the
 * whole root-owned chain is realigned to the nearest non-root ancestor — see
 * the `#1298 / #2717` ownership block in this module for why the parent dir
 * itself is the wrong reference.
 *
 * @param seedOnlyFilenames Basenames the template declared via
 *   `servicebay.seed-only-configs` (#2590). Such a file is written ONLY when
 *   it is absent on the node: its content belongs to the application or the
 *   operator from first install onward, so re-rendering the template's seed
 *   over it is data loss (ADR 0004). Everything not in this set keeps the
 *   unconditional-write behaviour every other config file relies on.
 *
 * @param options `completeDelivery` opts this deploy into the #2703 prune
 *   pass — see {@link ExtraConfigFileOptions}.
 */
export async function writeExtraConfigFiles(
    agent: FileWritingAgent,
    serviceName: string,
    extraFiles: { path: string; content: string }[],
    seedOnlyFilenames: ReadonlySet<string> = new Set<string>(),
    options: ExtraConfigFileOptions = {},
): Promise<void> {
    const failures: string[] = [];
    // #2703 — what this deploy delivers, and therefore what the manifest
    // will record. A seed-only path is NEVER recorded: its content belongs
    // to the application or the operator, so it must never become a delete
    // candidate, not even after the template stops declaring it.
    const delivered = extraFiles
        .map(f => f.path)
        .filter(p => !seedOnlyFilenames.has(p.substring(p.lastIndexOf('/') + 1)));
    for (const f of extraFiles) {
        // Ensure parent directory exists.
        const dir = f.path.substring(0, f.path.lastIndexOf('/'));

        // #2590 — the check happens BEFORE the mkdir/write so nothing about
        // the deploy reaches an existing seed-only target.
        if (await skipAsSeedOnly(agent, f.path, seedOnlyFilenames)) continue;
        // #2717 — the mkdir also reports the ownership reference for the
        // repair below, probed before anything is created.
        let ownerRef: string | null = null;
        if (dir) {
            ownerRef = await ensureDirAndProbeOwner(agent, dir);
        }
        let outcome = await attemptWrite(agent, f, false);
        let usedSudo = false;
        if (outcome !== 'ok') {
            logger.warn('ServiceManager', `write_file for ${f.path} failed (${outcome}); retrying with sudo.`);
            outcome = await attemptWrite(agent, f, true);
            usedSudo = true;
        }
        if (outcome !== 'ok') {
            failures.push(f.path);
            logger.error('ServiceManager', `Failed to write extra file ${f.path}: ${outcome}`);
        } else {
            // The plain (core-owned) write lands in a core-owned dir — fine.
            // Only the sudo path leaves a root-owned file — and, for a new
            // subdirectory, a root-owned directory chain — in an asset dir
            // owned by the consuming pod, which is what #1298/#2717 repair.
            if (usedSudo && dir) {
                await realignSudoWrite(agent, f.path, dir, ownerRef);
            }
            logger.info('ServiceManager', `Wrote extra config file: ${f.path}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `Failed to write ${failures.length} required config file(s) for service "${serviceName}":\n  ${failures.join('\n  ')}\n\n` +
            `The service was not started. Re-run the deploy or check the agent's write permissions on the target paths.`,
        );
    }

    // #2703 — only AFTER every write succeeded: a partial delivery must
    // never be recorded as the complete set, or the files it failed to
    // write would look stale on the next deploy and be deleted.
    if (options.completeDelivery) {
        await reconcileDeliveryManifest(agent, options.nodeName ?? 'Local', serviceName, delivered);
    }
}
