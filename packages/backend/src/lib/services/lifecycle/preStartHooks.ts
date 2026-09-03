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

    const mounts = container.volumeMounts || [];
    for (const mount of mounts) {
        if (!mount.name) continue;
        const hostPath = volumePaths.get(mount.name);
        if (!hostPath || mount.readOnly) continue;

        const agent = await agentManager.ensureAgent(nodeName);
        try {
            await agent.sendCommand('exec', {
                command: `podman unshare chown -R ${uid}:${gid} ${hostPath}`
            });
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
    agent: import('../../agent/handler').AgentHandler,
    image: string,
    dbHostPath: string,
    dbFile: string,
): Promise<void> {
    logger.info('ServiceManager', `Initializing FileBrowser DB at ${dbHostPath}/${dbFile} (config init + auth.method=proxy + admin user)`);
    await agent.sendCommand('exec', { command: `mkdir -p ${dbHostPath}` });

    const initCmd = [
        `podman run --rm --user 0:0`,
        `-v ${dbHostPath}:/db`,
        `${image}`,
        `config init --database /db/${dbFile}`,
    ].join(' ');
    const initRes = await agent.sendCommand('exec', { command: initCmd, timeout: 60 });
    if (initRes.code !== 0) {
        logger.warn('ServiceManager', `FileBrowser config init failed (code ${initRes.code}): ${initRes.stderr || initRes.stdout}`);
        return;
    }

    const setCmd = [
        `podman run --rm --user 0:0`,
        `-v ${dbHostPath}:/db`,
        `${image}`,
        `config set --auth.method=proxy --auth.header=Remote-User --database /db/${dbFile}`,
    ].join(' ');
    const setRes = await agent.sendCommand('exec', { command: setCmd, timeout: 60 });
    if (setRes.code !== 0) {
        logger.warn('ServiceManager', `FileBrowser config set --auth.method=proxy failed (code ${setRes.code}): ${setRes.stderr || setRes.stdout}`);
    }

    const userCmd = [
        `podman run --rm --user 0:0`,
        `-v ${dbHostPath}:/db`,
        `${image}`,
        `users add admin admin1234admin --perm.admin --database /db/${dbFile}`,
    ].join(' ');
    const result = await agent.sendCommand('exec', { command: userCmd, timeout: 60 });
    if (result.code === 0) {
        logger.info('ServiceManager', 'FileBrowser DB initialized: proxy-auth + admin user (password unused under proxy auth).');
    } else {
        logger.warn('ServiceManager', `FileBrowser users add failed: ${result.stderr || result.stdout}`);
    }
}

/**
 * Append `block` to `cfgFile` (heredoc) only when `topKey` (an
 * unindented YAML key, e.g. `automation:` / `script:`) is absent. Returns
 * true iff the block was appended. Shared by the HA self-heal hook so
 * each managed key is re-added independently after a backup-restore
 * brings back a user `configuration.yaml` without it. Idempotent: a
 * subsequent deploy finds the key present and leaves the file alone.
 */
async function appendYamlKeyIfMissing(
    agent: import('../../agent/handler').AgentHandler,
    cfgFile: string,
    topKey: string,
    block: string,
    label: string,
): Promise<boolean> {
    // grep -E for an unindented top-level key. The `:` is included so
    // `automation:` doesn't match a deeper `automation_foo:`; the key is
    // a fixed literal here so no escaping is needed.
    const probe = await agent.sendCommand('exec', { command: `grep -E '^${topKey}' ${cfgFile} || echo MISSING` });
    if (!probe.stdout?.includes('MISSING')) {
        logger.debug('ServiceManager', `HA configuration.yaml already has ${label}, leaving it alone`);
        return false;
    }
    logger.info('ServiceManager', `HA configuration.yaml missing ${label} — re-adding (likely after a backup-restore)`);
    const appendCmd = `cat >> ${cfgFile} <<'EOF'\n${block}\nEOF`;
    const res = await agent.sendCommand('exec', { command: appendCmd, timeout: 10 });
    if (res.code === 0) {
        logger.info('ServiceManager', `HA ${label} re-added`);
        return true;
    }
    logger.warn('ServiceManager', `HA ${label} append failed: ${res.stderr || res.stdout}`);
    return false;
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
    agent: import('../../agent/handler').AgentHandler,
    includeDir: string,
    includes: { key: string; file: string; seed: string; platform?: string }[],
): Promise<void> {
    const registryPath = `${includeDir}/.storage/core.entity_registry`;
    const regRes = await agent.sendCommand('exec', {
        command: `cat ${registryPath} 2>/dev/null || echo MISSING`,
    });
    const registryJson = regRes.stdout ?? '';
    // No registry yet (fresh install / first boot) → nothing to compare.
    if (registryJson.trim() === '' || registryJson.trim() === 'MISSING') return;

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

        const fileRes = await agent.sendCommand('exec', {
            command: `cat ${includeDir}/${inc.file} 2>/dev/null || echo MISSING`,
        });
        const raw = fileRes.stdout ?? '';
        // A genuinely missing file (the include target should always exist
        // after the seed loop above, but a race or manual delete is the
        // same hazard) is treated as 0 entries.
        const content = raw.trim() === 'MISSING' ? '' : raw;
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
    agent: import('../../agent/handler').AgentHandler,
    cfgFile: string,
): Promise<void> {
    // Only act when the file already exists. On a first-install the
    // template's mustache config is about to be written by the deploy flow
    // — let that path own initial seeding. On every subsequent deploy
    // (including post-restore), the file is there and we get to fix it.
    const exists = await agent.sendCommand('exec', { command: `test -f ${cfgFile} && echo yes` });
    if (exists.stdout?.trim() !== 'yes') return;

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
    for (const inc of includes) {
        // Ensure the include target exists (empty seed) so a freshly
        // re-added include never points at a missing file. `>>` + a guard
        // avoids clobbering a restored file that already has real content.
        await agent.sendCommand('exec', {
            command: `test -f ${includeDir}/${inc.file} || printf '%s\\n' '${inc.seed}' > ${includeDir}/${inc.file}`,
        });
        const block = `${inc.key} !include ${inc.file}`;
        await appendYamlKeyIfMissing(agent, cfgFile, inc.key, block, `${inc.key} !include`);
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
                const check = await agent.sendCommand('exec', { command: `test -f ${fullDbPath} && echo exists` });
                if (check.stdout?.trim() === 'exists') {
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
