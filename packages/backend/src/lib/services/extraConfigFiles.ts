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
 */

import { logger } from '../logger';

/** Minimal agent shape needed to ship files to a node. */
interface FileWritingAgent {
    sendCommand(action: string, params?: unknown): Promise<unknown>;
}

/**
 * #1298 — realign a sudo-written (root-owned) file to its parent dir's owner so
 * a later rootless `kube play --replace` relabel of the dir can still lsetxattr
 * it. Best-effort; logged but never fatal (the file is already written, and an
 * ownership mismatch only bites a later relabel).
 */
async function alignOwnershipToDir(agent: FileWritingAgent, path: string, dir: string): Promise<void> {
    try {
        const res = await agent.sendCommand('exec', { command: `sudo chown --reference=${dir} ${path}` });
        if (res && typeof res === 'object' && 'code' in res && (res as { code: unknown }).code !== 0) {
            logger.warn('ServiceManager', `chown to match ${dir} owner failed for ${path}: ${JSON.stringify(res)}`);
        }
    } catch (err) {
        logger.warn('ServiceManager', `chown to match ${dir} owner failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
 * #1298 — a sudo write lands the new file owned by root (uid 0). But the
 * only reason the unprivileged write failed is that the asset dir is owned
 * by the consuming rootless pod's subuid; a root-owned file inside it
 * breaks the next `podman kube play --replace` of that pod — rootless
 * podman can't `lsetxattr` (relabel) a path it doesn't own, so the volume
 * relabel fails and the pod won't restart. After a sudo write we therefore
 * realign the file's ownership to its parent directory (i.e. the subuid the
 * siblings already use) so the relabel stays possible. Best-effort: the file
 * is already written, and an ownership mismatch only bites a later relabel,
 * so a chown failure is logged but does not fail the deploy.
 *
 * @param seedOnlyFilenames Basenames the template declared via
 *   `servicebay.seed-only-configs` (#2590). Such a file is written ONLY when
 *   it is absent on the node: its content belongs to the application or the
 *   operator from first install onward, so re-rendering the template's seed
 *   over it is data loss (ADR 0004). Everything not in this set keeps the
 *   unconditional-write behaviour every other config file relies on.
 */
export async function writeExtraConfigFiles(
    agent: FileWritingAgent,
    serviceName: string,
    extraFiles: { path: string; content: string }[],
    seedOnlyFilenames: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
    const failures: string[] = [];
    // Returns 'ok' on success, otherwise the failure reason as a string —
    // covering both the rejection (agent error reply) and the defensive
    // non-'ok' return value cases.
    const attemptWrite = async (target: { path: string; content: string }, sudo: boolean): Promise<string> => {
        try {
            const res = await agent.sendCommand('write_file', { path: target.path, content: target.content, ...(sudo ? { sudo: true } : {}) });
            return res === 'ok' ? 'ok' : JSON.stringify(res);
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
    };
    for (const f of extraFiles) {
        // Ensure parent directory exists.
        const dir = f.path.substring(0, f.path.lastIndexOf('/'));

        // #2590 — the check happens BEFORE the mkdir/write so nothing about
        // the deploy reaches an existing seed-only target.
        if (await skipAsSeedOnly(agent, f.path, seedOnlyFilenames)) continue;
        if (dir) {
            await agent.sendCommand('exec', { command: `mkdir -p ${dir}` });
        }
        let outcome = await attemptWrite(f, false);
        let usedSudo = false;
        if (outcome !== 'ok') {
            logger.warn('ServiceManager', `write_file for ${f.path} failed (${outcome}); retrying with sudo.`);
            outcome = await attemptWrite(f, true);
            usedSudo = true;
        }
        if (outcome !== 'ok') {
            failures.push(f.path);
            logger.error('ServiceManager', `Failed to write extra file ${f.path}: ${outcome}`);
        } else {
            // The plain (core-owned) write lands in a core-owned dir — fine.
            // Only the sudo path leaves a root-owned file in a subuid-owned
            // asset dir, which is what #1298 has to repair.
            if (usedSudo && dir) {
                await alignOwnershipToDir(agent, f.path, dir);
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
}
