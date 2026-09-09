/**
 * Pre-start hooks: per-image initialization that must happen after the files
 * are written and the images pulled, but BEFORE the unit starts (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: the volume-ownership fixup, the
 * FileBrowser DB seed, the Home Assistant `configuration.yaml` self-heal and
 * the #1864 config-integrity guard that refuses a deploy onto a hollowed-out
 * config.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import yaml from 'js-yaml';
import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import type { PodLikeDoc, PodLikeVolumeMount } from '../containerNameMatcher';

/**
 * A pre-start hook failure that must ABORT the deploy.
 *
 * `runPreStartHooks` deliberately swallows hook errors — a malformed pod spec
 * or an unreachable optional path should not fail an otherwise fine deploy.
 * But that catch-all also swallowed the #1864 HA config-integrity guard, whose
 * entire job is to refuse the deploy when the config on disk is already
 * hollowed out (#2590: the guard's condition was live on the owner's box for
 * eight diagnose runs while deploys kept sailing through). Errors of this type
 * are re-thrown by the catch-all instead.
 */
class FatalPreStartHookError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalPreStartHookError';
    }
}

type HookAgent = import('../../agent/handler').AgentHandler;

interface HostExecResult { code?: number; stdout?: string; stderr?: string }

/**
 * Run an argv on the host through the agent's `safe_exec` (#2928).
 *
 * EVERY host command in this module that carries a value taken out of the
 * caller's pod manifest — `hostPath.path`, `securityContext.runAsUser`,
 * `container.image` — goes through here rather than through `sendCommand
 * ('exec', { command })`. `safe_exec` hands the list to the host verbatim,
 * so there is no shell to parse a `;` or a `$(…)` out of a path: the value
 * is one argument, whatever it contains.
 *
 * Before #2928 the ownership fixup built `podman unshare chown -R
 * ${uid}:${gid} ${hostPath}` as a command string, which handed anybody who
 * could write a manifest a shell as the agent user — defeating the whole
 * mutate-vs-exec scope split of #591/#2623. `deployKubeService` now also
 * refuses such a manifest up front (`validatePodManifest`), but this is the
 * layer that holds even if a future write path forgets to validate.
 */
async function hostExec(agent: HookAgent, argv: string[], timeout?: number): Promise<HostExecResult> {
    const payload: { argv: string[]; timeout?: number } = { argv };
    if (timeout !== undefined) payload.timeout = timeout;
    return (await agent.sendCommand('safe_exec', payload)) as HostExecResult;
}

/** `test -f <path>` on the host, argv-passed. Any failure ⇒ "not there". */
async function hostFileExists(agent: HookAgent, path: string): Promise<boolean> {
    try {
        const res = await hostExec(agent, ['test', '-f', path]);
        return res?.code === 0;
    } catch {
        return false;
    }
}

/** `cat <path>` on the host, argv-passed. Missing/unreadable ⇒ null. */
async function hostReadFile(agent: HookAgent, path: string): Promise<string | null> {
    const res = await hostExec(agent, ['cat', path]);
    if (res?.code !== 0) return null;
    return res.stdout ?? '';
}

/**
 * Overwrite a host file through the agent's structured `write_file`.
 *
 * Best-effort, like the `cat >> … <<'EOF'` heredoc it replaced: a failed
 * write is logged and the hook carries on, so a permission problem on the
 * config file never skips the #1864 integrity guard that runs after it.
 */
async function hostWriteFile(agent: HookAgent, path: string, content: string): Promise<void> {
    try {
        await agent.sendCommand('write_file', { path, content });
    } catch (e) {
        logger.warn('ServiceManager', `Failed to write ${path}:`, e);
    }
}

/** A uid/gid that can be handed to `chown` — a plain non-negative integer. */
function isUnixId(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Fix volume ownership for containers with explicit runAsUser/runAsGroup.
 *  In rootless podman, host UIDs map differently inside the user namespace.
 *  Uses `podman unshare chown` to translate container UIDs to correct host UIDs. */
async function chownContainerMounts(
    nodeName: string,
    container: NonNullable<NonNullable<PodLikeDoc['spec']>['containers']>[number],
    volumePaths: Map<string, string>,
): Promise<void> {
    const uid = container.securityContext?.runAsUser;
    const gid = container.securityContext?.runAsGroup ?? uid;
    if (uid == null || uid === 0) return; // Skip root or unset
    // The schema types these as non-negative integers; re-assert it here so a
    // write path that skipped validation still cannot shape the chown target.
    if (!isUnixId(uid) || !isUnixId(gid)) {
        logger.warn('ServiceManager', `Ignoring non-integer runAsUser/runAsGroup on container "${container.name}"`);
        return;
    }

    const mounts = container.volumeMounts || [];
    for (const mount of mounts) {
        if (!mount.name) continue;
        const hostPath = volumePaths.get(mount.name);
        if (!hostPath || mount.readOnly) continue;

        const agent = await agentManager.ensureAgent(nodeName);
        try {
            await hostExec(agent, ['podman', 'unshare', 'chown', '-R', `${uid}:${gid}`, hostPath]);
            logger.info('ServiceManager', `Fixed volume ownership: ${hostPath} -> ${uid}:${gid}`);
        } catch (e) {
            logger.warn('ServiceManager', `Failed to fix ownership for ${hostPath}:`, e);
        }
    }
}

export async function fixVolumeOwnership(nodeName: string, yamlContent: string) {
    try {
        const docs = yaml.loadAll(yamlContent) as PodLikeDoc[];
        for (const doc of docs) {
            if (!doc?.spec) continue;
            const containers = doc.spec.containers || [];
            const volumes = doc.spec.volumes || [];

            // Build volume name -> hostPath map
            const volumePaths = new Map<string, string>();
            for (const vol of volumes) {
                if (vol.name && vol.hostPath?.path) {
                    volumePaths.set(vol.name, vol.hostPath.path);
                }
            }

            for (const container of containers) {
                await chownContainerMounts(nodeName, container, volumePaths);
            }
        }
    } catch (e) {
        logger.debug('ServiceManager', 'Volume ownership fix skipped:', e);
    }
}

/**
 * FileBrowser DB initialization hook.
 */
async function runFileBrowserHook(
    agent: HookAgent,
    image: string,
    dbHostPath: string,
    dbFile: string,
): Promise<void> {
    logger.info('ServiceManager', `Initializing FileBrowser DB at ${dbHostPath}/${dbFile} (config init + auth.method=proxy + admin user)`);
    await hostExec(agent, ['mkdir', '-p', dbHostPath]);

    // `dbHostPath` is the manifest's hostPath and `image` the manifest's
    // image — both argv-passed (#2928), never spliced into a shell string.
    const podmanRun = (...args: string[]): string[] => [
        'podman', 'run', '--rm', '--user', '0:0',
        '-v', `${dbHostPath}:/db`,
        image,
        ...args,
    ];

    const initRes = await hostExec(agent, podmanRun('config', 'init', '--database', `/db/${dbFile}`), 60);
    if (initRes.code !== 0) {
        logger.warn('ServiceManager', `FileBrowser config init failed (code ${initRes.code}): ${initRes.stderr || initRes.stdout}`);
        return;
    }

    const setRes = await hostExec(agent, podmanRun(
        'config', 'set', '--auth.method=proxy', '--auth.header=Remote-User', '--database', `/db/${dbFile}`,
    ), 60);
    if (setRes.code !== 0) {
        logger.warn('ServiceManager', `FileBrowser config set --auth.method=proxy failed (code ${setRes.code}): ${setRes.stderr || setRes.stdout}`);
    }

    const result = await hostExec(agent, podmanRun(
        'users', 'add', 'admin', 'admin1234admin', '--perm.admin', '--database', `/db/${dbFile}`,
    ), 60);
    if (result.code === 0) {
        logger.info('ServiceManager', 'FileBrowser DB initialized: proxy-auth + admin user (password unused under proxy auth).');
    } else {
        logger.warn('ServiceManager', `FileBrowser users add failed: ${result.stderr || result.stdout}`);
    }
}

/**
 * Append `block` to `current` only when `topKey` (an unindented YAML key,
 * e.g. `automation:` / `script:`) is absent. Returns the new content, or
 * null when the key is already there and the file must be left alone.
 * Shared by the HA self-heal hook so each managed key is re-added
 * independently after a backup-restore brings back a user
 * `configuration.yaml` without it. Idempotent: a subsequent deploy finds
 * the key present and returns null.
 *
 * Pure since #2928: the probe used to be `grep -E '^key' <cfgFile>` and the
 * append a `cat >> <cfgFile> <<'EOF'` heredoc, both of which spliced the
 * manifest's hostPath into a shell command string. The caller now reads the
 * file once (argv `cat`) and writes it back once (`write_file`), so this
 * function never touches the host at all.
 */
function appendYamlKeyIfMissing(
    current: string,
    topKey: string,
    block: string,
    label: string,
): string | null {
    // An unindented top-level key. The `:` is part of `topKey` so
    // `automation:` doesn't match a deeper `automation_foo:`.
    const keyRe = new RegExp('^' + topKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
    if (keyRe.test(current)) {
        logger.debug('ServiceManager', `HA configuration.yaml already has ${label}, leaving it alone`);
        return null;
    }
    logger.info('ServiceManager', `HA configuration.yaml missing ${label} — re-adding (likely after a backup-restore)`);
    const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    return `${base}${block}\n`;
}

/**
 * Count entity-registry entries for a given `platform` (e.g. `automation`,
 * `script`, `scene`). The registry lives at `<config>/.storage/
 * core.entity_registry` and is JSON of the shape
 * `{ data: { entities: [{ platform: 'automation', ... }, ...] } }`.
 * Missing/unreadable/unparseable registry → 0 (we only ever *raise* an
 * alarm on a positive registry count, so an absent registry is silent).
 */
function countRegistryPlatformEntries(
    registryJson: string,
    platform: string,
): number {
    try {
        const parsed = JSON.parse(registryJson) as {
            data?: { entities?: Array<{ platform?: string }> };
        };
        const entities = parsed?.data?.entities;
        if (!Array.isArray(entities)) return 0;
        return entities.filter((e) => e?.platform === platform).length;
    } catch {
        return 0;
    }
}

/**
 * Parse a HA include target file (`automations.yaml` / `scripts.yaml` /
 * `scenes.yaml`) and return the number of defined entries. Automations and
 * scenes are YAML lists (`[]` → 0); scripts are a YAML mapping (`{}` → 0).
 * A blank/missing file is 0. Unparseable content returns `null` so the
 * caller can avoid raising a false mismatch on a file it can't read.
 */
function parseHaEntryCount(content: string): number | null {
    const trimmed = content.trim();
    if (trimmed === '') return 0;
    let doc: unknown;
    try {
        doc = yaml.load(content);
    } catch {
        return null;
    }
    if (doc === null || doc === undefined) return 0;
    if (Array.isArray(doc)) return doc.length;
    if (typeof doc === 'object') return Object.keys(doc as object).length;
    // A scalar (shouldn't happen for these files) — treat as unparseable.
    return null;
}

/**
 * #1864 integrity guard. Reads the HA entity registry and each include
 * target file from the host (via the agent) and THROWS — aborting the
 * pre-start hook and the deploy — when the registry lists N>0 entities of
 * a platform but the corresponding config file parses to 0 entries. It
 * never writes, deletes, or repairs anything; the only side effect is a
 * loud log + a structured Error so the operator notices BEFORE HA starts
 * on top of an emptied config.
 */
async function assertHaConfigIntegrity(
    agent: HookAgent,
    includeDir: string,
    includes: { key: string; file: string; seed: string; platform?: string }[],
): Promise<void> {
    const registryPath = `${includeDir}/.storage/core.entity_registry`;
    const registryJson = (await hostReadFile(agent, registryPath)) ?? '';
    // No registry yet (fresh install / first boot) → nothing to compare.
    if (registryJson.trim() === '') return;

    // platform name per include file (drop the trailing `:` from the key).
    const platformFor: Record<string, string> = {
        'automations.yaml': 'automation',
        'scripts.yaml': 'script',
        'scenes.yaml': 'scene',
    };

    const mismatches: string[] = [];
    for (const inc of includes) {
        const platform = platformFor[inc.file];
        if (!platform) continue;
        const registered = countRegistryPlatformEntries(registryJson, platform);
        if (registered === 0) continue;

        // A genuinely missing file (the include target should always exist
        // after the seed loop above, but a race or manual delete is the
        // same hazard) is treated as 0 entries.
        const content = (await hostReadFile(agent, `${includeDir}/${inc.file}`)) ?? '';
        const parsed = parseHaEntryCount(content);
        // null = unparseable; don't raise a false alarm on a file we can't
        // read (HA itself would error on it, which is its own signal).
        if (parsed === null) continue;
        if (parsed === 0) {
            mismatches.push(
                `${inc.file}: registry lists ${registered} ${platform} entit${registered === 1 ? 'y' : 'ies'} but the file parses to 0 entries`,
            );
        }
    }

    if (mismatches.length > 0) {
        const summary = mismatches.join('; ');
        const message =
            `HA config integrity check FAILED — refusing to start Home Assistant on top of an emptied config. ${summary}. ` +
            `This is the fingerprint of the automations/scripts/scenes data-loss incident: the entity registry still references these entities but their config file is empty, so starting HA would let it overwrite the only remaining copy. ` +
            `ServiceBay has NOT modified or deleted anything. Restore ${includeDir} from a backup (or confirm the data really was removed) before redeploying.`;
        logger.error('ServiceManager', message);
        throw new FatalPreStartHookError(message);
    }
}

/**
 * Home Assistant configuration.yaml self-healing hook.
 *
 * A HA backup-restore replaces ServiceBay's base `configuration.yaml`
 * with the snapshot's own — which carries the user's content but, on a
 * pre-#1687 box, NOT the `automation:` / `script:` / `scene:` includes.
 * Without those a restored `automations.yaml` never loads (every
 * automation `unavailable`).
 *
 * We re-add each managed key independently when it's missing, and ensure
 * the three include target files exist (empty is fine — restore overwrote
 * them with real content), so a restored user config keeps all of the
 * user's own settings AND ServiceBay's needs are present again.
 *
 * The `http:` trusted-proxies block used to be re-added here too. It is
 * NOT any more (#2573): HA 2026.8 moved that setting into its own store
 * and raises a permanent repair issue for as long as an `http:` block is
 * left in the YAML, so re-appending it every deploy meant the operator
 * could never clear the warning. This hook runs BEFORE HA starts, so it
 * cannot tell which HA era the box is on; `templates/home-assistant/
 * post-deploy.py` owns the trust list now, where HA is running and can be
 * asked. The `auth_oidc:` block was likewise already owned there, because
 * it needs rendered variable values this hook does not have.
 *
 * Public for unit testing (`serviceLifecycle.homeAssistantHook.test.ts`);
 * the production caller is `runPreStartHooks`.
 */
export async function runHomeAssistantHook(
    agent: HookAgent,
    cfgFile: string,
): Promise<void> {
    // Only act when the file already exists. On a first-install the
    // template's mustache config is about to be written by the deploy flow
    // — let that path own initial seeding. On every subsequent deploy
    // (including post-restore), the file is there and we get to fix it.
    if (!await hostFileExists(agent, cfgFile)) return;

    // UI-editable automations/scripts/scenes only load when their
    // `!include` line is in configuration.yaml. A backup-restore brings
    // the data files back but not the includes (#1687) — re-add each
    // missing one and make sure its target file exists so HA doesn't
    // error on a dangling include.
    const includeDir = cfgFile.replace(/\/configuration\.yaml$/, '');
    const includes: { key: string; file: string; seed: string }[] = [
        { key: 'automation:', file: 'automations.yaml', seed: '[]' },
        { key: 'script:', file: 'scripts.yaml', seed: '{}' },
        { key: 'scene:', file: 'scenes.yaml', seed: '[]' },
    ];
    // One argv read of the config, all three keys decided in-process, one
    // structured write back (#2928) — instead of six shell commands built
    // around the manifest-supplied config path.
    let cfgContent = (await hostReadFile(agent, cfgFile)) ?? '';
    let cfgChanged = false;
    for (const inc of includes) {
        // Ensure the include target exists (empty seed) so a freshly
        // re-added include never points at a missing file. The existence
        // probe guards it, so a restored file with real content is never
        // clobbered.
        const targetPath = `${includeDir}/${inc.file}`;
        if (!await hostFileExists(agent, targetPath)) {
            await hostWriteFile(agent, targetPath, `${inc.seed}\n`);
        }
        const block = `${inc.key} !include ${inc.file}`;
        const updated = appendYamlKeyIfMissing(cfgContent, inc.key, block, `${inc.key} !include`);
        if (updated !== null) {
            cfgContent = updated;
            cfgChanged = true;
        }
    }
    if (cfgChanged) {
        await hostWriteFile(agent, cfgFile, cfgContent);
        logger.info('ServiceManager', 'HA configuration.yaml includes re-added');
    }

    // Integrity guard (#1864): refuse-and-shout when the entity registry
    // says HA owns N>0 automation/script/scene entities but the include
    // target file parses to 0 entries. That mismatch is the fingerprint of
    // the data-loss incident — a restore (or a bad write) left an empty
    // `automations.yaml` while the registry still references the
    // automations, so HA would silently start with every automation gone.
    // The guard does NOT mutate or delete anything: its job is to ABORT
    // the hook (and therefore the deploy) loudly rather than let HA come
    // up on top of a hollowed-out config that overwrites the only copy.
    await assertHaConfigIntegrity(agent, includeDir, includes);
}

/**
 * Run pre-start hooks for known images that need initialization (e.g. filebrowser DB).
 * This runs AFTER files are written and images are pulled, but BEFORE the service starts.
 */
export async function runPreStartHooks(nodeName: string, name: string, yamlContent: string) {
    try {
        const docs = yaml.loadAll(yamlContent) as PodLikeDoc[];
        for (const doc of docs) {
            if (!doc?.spec) continue;
            const containers = doc.spec.containers || [];
            const volumes = doc.spec.volumes || [];

            const volumePaths = new Map<string, string>();
            for (const vol of volumes) {
                if (vol.name && vol.hostPath?.path) volumePaths.set(vol.name, vol.hostPath.path);
            }

            for (const container of containers) {
                const image = container.image || '';

                // Home Assistant configuration.yaml self-healing hook
                // (the automation/script/scene includes + integrity guard).
                if (image.includes('home-assistant') && container.name !== 'matter-server' && container.name !== 'zwave-js') {
                    const configMount = (container.volumeMounts || []).find(
                        (m: PodLikeVolumeMount) => m.mountPath === '/config'
                    );
                    const configHostPath = configMount ? volumePaths.get(configMount.name!) : null;
                    if (!configHostPath) continue;
                    const cfgFile = `${configHostPath}/configuration.yaml`;
                    const agent = await agentManager.ensureAgent(nodeName);
                    await runHomeAssistantHook(agent, cfgFile);
                    continue;
                }

                if (!image.includes('filebrowser')) continue;

                // Find the database volume mount. file-share/template.yml
                // mounts the DB at `/database` (legacy templates used `/db`);
                // accept either so a wider set of layouts hit this hook.
                const dbMount = (container.volumeMounts || []).find(
                    (m: PodLikeVolumeMount) => m.mountPath === '/db' || m.mountPath === '/database'
                );
                const dbHostPath = dbMount ? volumePaths.get(dbMount.name!) : null;
                if (!dbHostPath) continue;

                const dbFile = 'filebrowser.db';
                const fullDbPath = `${dbHostPath}/${dbFile}`;
                const agent = await agentManager.ensureAgent(nodeName);

                // Check if DB already exists (don't overwrite on redeploy)
                if (await hostFileExists(agent, fullDbPath)) {
                    logger.debug('ServiceManager', `FileBrowser DB already exists at ${fullDbPath}, skipping init`);
                    continue;
                }

                await runFileBrowserHook(agent, image, dbHostPath, dbFile);
            }
        }
    } catch (e) {
        // A guard that refuses the deploy on purpose must survive this
        // catch-all — otherwise "refuse and shout" degrades to "log at
        // debug and carry on" (#2590).
        if (e instanceof FatalPreStartHookError) throw e;
        logger.debug('ServiceManager', 'Pre-start hooks skipped:', e);
    }
}
