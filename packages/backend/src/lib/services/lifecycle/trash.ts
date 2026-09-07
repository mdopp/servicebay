/**
 * Soft-delete / restore / purge — the trash bucket (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`, including the #2541 capability
 * event pair that tears down (and rebuilds) a service's cross-service state:
 * Authelia OIDC client, NPM proxy host, AdGuard rewrite, credentials-manifest
 * entry and the `blockLanAccess` firewall rule.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { assertTrashId } from '../../api/schemas';
import { getConfig, saveConfig } from '../../config';
import { getTemplateVariables } from '../../registry';
import {
    reconstructTemplateVariables,
    emitFeatureUninstalling,
    emitFeatureUninstalled,
    emitFeatureRestored,
    recordCapabilityOutcome,
    type CapabilityFailure,
} from '../../capabilities/serviceLifecycleEvents';
import type { StackVariable } from '../../stackInstall/types';
import { ServiceListing } from '../serviceListing';
import { reloadDaemon, startAndWaitForActive, type StartSettleResult } from './units';
import { SYSTEMD_DIR, backupQuadlets, refreshAgent } from './quadletFiles';
import {
    TRASH_DIR,
    ensureTrashRootMigrated,
    shellPath,
    trashDisplayPath,
    trashEntryArg,
} from './trashPaths';

/**
 * Pre-stop half of an uninstall (#2541): reconstruct the install-time
 * variables while the unit is still up and fire `feature.uninstalling`.
 * Returns the map — both uninstall events must see the same one, and a
 * reconstruction failure degrades to "no cleanup context" rather than
 * blocking the delete.
 */
async function beginUninstall(serviceName: string): Promise<StackVariable[]> {
    const lastKnownVariables = await reconstructTemplateVariables(serviceName).catch(e => {
        logger.warn('ServiceManager', `Could not reconstruct variables for ${serviceName}:`, e);
        return [] as StackVariable[];
    });
    // #2859 — the NPM/Authelia/AdGuard handlers match a registration to a
    // service through the template's DECLARED variables. A service whose
    // template manifest is gone (removed from the catalogue, or never
    // template-installed) therefore has nothing to match on and its proxy host
    // survives the delete — silently, until now. Say so in the journal, and
    // keep the `delete_service` tool description honest about it.
    const declarations = await getTemplateVariables(serviceName).catch(() => null);
    if (declarations) {
        logger.info(
            'ServiceManager',
            `Cross-service cleanup for ${serviceName}: matching its Authelia client / NPM proxy host / AdGuard rewrite off the template manifest`,
        );
    } else {
        logger.warn(
            'ServiceManager',
            `No template manifest for ${serviceName} — cross-service cleanup has nothing to match on; an NPM proxy host or AdGuard rewrite for it stays and must be removed manually (remove_proxy_route)`,
        );
    }
    for (const f of await emitFeatureUninstalling(serviceName, lastKnownVariables)) {
        logger.warn('ServiceManager', `${f.handler} (uninstalling ${serviceName}): ${f.message}`);
    }
    return lastKnownVariables;
}

/**
 * Post-removal half: drop the per-service health check (#1506) —
 * otherwise an uninstalled service lingers as a red "failing" row
 * forever — then fire `feature.uninstalled` so the Authelia client,
 * proxy host, AdGuard rewrite, credentials entry and firewall rule go
 * with it (#2541). Non-blocking: the unit is already gone, so a handler
 * that can't reach Authelia/NPM becomes a standing diagnose finding
 * rather than a failed delete.
 */
async function finishUninstall(
    serviceName: string,
    lastKnownVariables: StackVariable[],
    emitEvents: boolean,
): Promise<void> {
    try {
        const { HealthStore } = await import('../../health/store');
        const removed = HealthStore.deleteServiceCheck(serviceName);
        if (removed > 0) logger.info('ServiceManager', `Removed ${removed} health check(s) for uninstalled ${serviceName}`);
    } catch (e) {
        logger.warn('ServiceManager', `Failed to remove health check for ${serviceName}:`, e);
    }
    if (!emitEvents) return;
    await recordCapabilityOutcome(
        serviceName,
        await emitFeatureUninstalled(serviceName, lastKnownVariables),
        'uninstalling',
    );
}

/** The `config.installedTemplates` value shape (see lib/config.ts). */
type InstalledTemplateRecord = { schemaVersion: number; installedAt: string };

/**
 * Take the service's `installedTemplates` record out of the persisted config
 * and hand it to the caller for the trash manifest (#2863).
 *
 * read → mutate → `saveConfig` (NOT `updateConfig`, whose deepMerge cannot
 * delete a key — the same reason `pruneOrphanedTemplates` writes this way).
 * Returns `null` when there was no record, which is also what a non-template
 * service looks like.
 */
async function takeInstalledTemplateRecord(serviceName: string): Promise<InstalledTemplateRecord | null> {
    try {
        const config = await getConfig();
        const installed = config.installedTemplates ?? {};
        const record = installed[serviceName];
        if (!record) return null;
        const next = { ...installed };
        delete next[serviceName];
        config.installedTemplates = next;
        await saveConfig(config);
        logger.info('ServiceManager', `Dropped installedTemplates record for deleted ${serviceName} (#2863)`);
        return record;
    } catch (e) {
        logger.warn('ServiceManager', `Could not drop installedTemplates record for ${serviceName}:`, e);
        return null;
    }
}

/** Put a trashed service's `installedTemplates` record back (#2863). Restoring
 *  the files without it leaves upgrade planning, migrations and backup gating
 *  blind to a service that is running again. */
async function putBackInstalledTemplateRecord(
    serviceName: string,
    record: InstalledTemplateRecord | null | undefined,
): Promise<void> {
    if (!record) return;
    try {
        const config = await getConfig();
        config.installedTemplates = { ...(config.installedTemplates ?? {}), [serviceName]: record };
        await saveConfig(config);
        logger.info('ServiceManager', `Restored installedTemplates record for ${serviceName} (#2863)`);
    } catch (e) {
        logger.warn('ServiceManager', `Could not restore installedTemplates record for ${serviceName}:`, e);
    }
}

/**
 * Soft-delete a service: stop the unit, then *move* its .kube/.container and
 * .yml files into ~/.config/containers/systemd-trash/<ts>-<name>/ instead
 * of deleting them. That root is a SIBLING of the Quadlet scan directory on
 * purpose (#2862): trash kept *inside* `containers/systemd/` is read by the
 * Quadlet generator, so a deleted service comes back as a unit wired to
 * `default.target` and starts on the next boot. The operator (or an MCP client) can `restore_from_trash`
 * to undo within 7 days; `purge_trash` actually removes them. Auto-purge
 * older than 7 days runs on server startup.
 *
 * Why "move, don't rm": delete-by-mistake is the easiest way to lose
 * service config, and the existing system-backup mechanism only takes
 * snapshots periodically. A trash bucket gives an immediate one-step
 * recovery without restoring from a backup tarball.
 *
 * Cross-service cleanup (#2541): the same `feature.uninstalling` /
 * `feature.uninstalled` pair the stack wipe fires, so one deleted
 * service no longer leaves its Authelia OIDC client, NPM proxy host,
 * AdGuard rewrite, credentials-manifest entry and `blockLanAccess`
 * firewall rule behind. The counterpart lives in
 * {@link restoreTrashedService}, which re-provisions all five — the
 * cleanup is only safe because the trash bin can rebuild.
 *
 * `emitCapabilityEvents: false` is for callers that own the events
 * themselves (the stack-wipe route) or that are not really uninstalling
 * (the predecessor migration).
 */
export async function deleteService(
    nodeName: string,
    serviceName: string,
    opts: { emitCapabilityEvents?: boolean } = {},
) {
    const emitEvents = opts.emitCapabilityEvents !== false;
    const lastKnownVariables = emitEvents ? await beginUninstall(serviceName) : [];

    const { yamlPath } = await ServiceListing.getServiceFiles(nodeName, serviceName);
    const agent = await agentManager.ensureAgent(nodeName);

    // Stop
    try {
        await agent.sendCommand('exec', { command: `systemctl --user stop ${serviceName}.service` });
    } catch { /* ignore if already stopped */ }

    // Sweep any legacy trash (in-scan `.trash/`, or the literal `~` directory
    // #2859 created) into the sibling root first, so a delete never adds to a
    // location the Quadlet generator reads.
    await ensureTrashRootMigrated(nodeName);

    // Move the files into the trash bucket. ISO-8601 with no colons in
    // the name so it sorts by timestamp and survives shells that hate
    // colons in paths.
    const trashStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashId = `${trashStamp}-${serviceName}`;
    const trashDirArg = trashEntryArg(trashId);
    /** Destination for `mv` — trailing slash INSIDE the quotes, so the shell
     *  sees one word and the move can only ever land inside the directory. */
    const trashDestArg = shellPath(`${TRASH_DIR}/${trashId}/`);
    await agent.sendCommand('exec', { command: `mkdir -p ${trashDirArg}` });

    // Move the unit and EVERY sibling of the same name. A `.kube` alone is not
    // the service: a post-deploy can swap it to a `.container` (#2174), and the
    // pod spec lives next to it as `<name>.yml`. Leaving one behind kept
    // `ollama` listed as inactive/dead after its delete (#2859).
    const siblings = [`${serviceName}.kube`, `${serviceName}.container`, `${serviceName}.yml`];
    for (const sibling of siblings) {
        await agent.sendCommand('exec', {
            command: `mv -f ${shellPath(`${SYSTEMD_DIR}/${sibling}`)} ${trashDestArg} 2>/dev/null || true`,
        });
    }

    // …plus the yaml the unit actually points at, when it lives elsewhere
    // (legacy migrations put it outside SYSTEMD_DIR).
    const yamlBasename = yamlPath ? yamlPath.split('/').pop() : null;
    if (yamlPath && yamlBasename && !siblings.includes(yamlBasename)) {
        await agent.sendCommand('exec', {
            command: `mv -f ${shellPath(yamlPath)} ${trashDestArg} 2>/dev/null || true`,
        });
    }

    // #2863 — the `installedTemplates` record is part of the service, so it
    // goes into the trash WITH the files, in this same code path. Anything
    // else lets config.json drift from the real service set the moment a
    // delete half-succeeds (5 orphaned records measured on the box).
    const installedTemplate = await takeInstalledTemplateRecord(serviceName);

    // Stash a small manifest so restore knows the original yaml path
    // even if it lived outside the systemd dir (legacy migrations did).
    const manifest = JSON.stringify({
        service: serviceName,
        deletedAt: new Date().toISOString(),
        originalYamlPath: yamlPath || null,
        // `$HOME`-relative, never `~/…`: this value is read back into a
        // command on restore, and a tilde there is what #2859 was.
        originalKubePath: `${SYSTEMD_DIR}/${serviceName}.kube`,
        installedTemplate,
    });
    await agent.sendCommand('exec', {
        command: `printf '%s' ${JSON.stringify(manifest)} > ${trashEntryArg(`${trashId}/.manifest.json`)}`,
    });

    await reloadDaemon(nodeName);

    // Clear failed state
    try {
        await agent.sendCommand('exec', { command: `systemctl --user reset-failed ${serviceName}.service` });
    } catch { /* unit may not be in failed state */ }

    await refreshAgent(nodeName);
    backupQuadlets(nodeName);

    await finishUninstall(serviceName, lastKnownVariables, emitEvents);

    logger.info('ServiceManager', `Soft-deleted ${serviceName} on ${nodeName} → ${trashDisplayPath(trashId)}`);
}

/**
 * Move EVERY file a delete took back where it came from — the `.kube`, a
 * `.container` sibling and the pod spec. The entry, not just the kube, is the
 * service: restoring one file leaves the rest in the trash and the service
 * half-dead (#2859).
 */
async function moveTrashedFilesBack(
    agent: { sendCommand: (action: string, params: unknown) => Promise<{ stdout?: unknown } | unknown> },
    trashId: string,
    originalYamlPath: string | null,
): Promise<void> {
    const yamlBasename = originalYamlPath?.split('/').pop() ?? null;
    const ls = await agent.sendCommand('exec', { command: `ls -1 ${trashEntryArg(trashId)} 2>/dev/null` }) as { stdout?: unknown };
    const entries = String((ls?.stdout ?? '') as string)
        .trim()
        .split('\n')
        .map(e => e.trim())
        .filter(e => e && e !== '.manifest.json');
    for (const entry of entries) {
        // Names come off the box; anything outside the Quadlet filename shape
        // is left in the trash rather than interpolated into a command.
        if (!/^[A-Za-z0-9._-]+$/.test(entry)) {
            logger.warn('ServiceManager', `Skipping unexpected trash file name in ${trashId}: ${entry}`);
            continue;
        }
        const target = entry === yamlBasename && originalYamlPath ? originalYamlPath : `${SYSTEMD_DIR}/${entry}`;
        await agent.sendCommand('exec', {
            command: `mv -f ${shellPath(`${TRASH_DIR}/${trashId}/${entry}`)} ${shellPath(target)} 2>/dev/null || true`,
        });
    }
}

/** What a restore did (#2541 re-provisioning, #2756 unit startup). */
export interface RestoreResult {
    service: string;
    capabilityFailures: CapabilityFailure[];
    /** How the restored unit is doing — `active` once it is up, `converging`
     *  while it is still coming up, `failed`/`error` when it will not. */
    startup: StartSettleResult;
}

/**
 * Bring one soft-deleted service back out of the trash bucket.
 *
 * Moves the Quadlet + YAML back, reloads systemd — and re-provisions
 * the cross-service state {@link deleteService} tore down (#2541), by
 * firing `feature.installed` exactly as an install would: Authelia OIDC
 * client, NPM proxy host, AdGuard rewrite, credentials-manifest entry,
 * `blockLanAccess` firewall rule. Without this half, restore would hand
 * the operator back a service with no SSO and no route, at the exact
 * moment they are undoing a mistake.
 *
 * Values come from durable config, not from the trashed files — see
 * `reconstructTemplateVariables` for what that can and cannot recover.
 *
 * Finally it starts the unit again (#2756) — the delete stopped it — and
 * reports the startup state, so a caller never sees a "restored" service that
 * is silently dead.
 */
export async function restoreTrashedService(nodeName: string, trashId: string): Promise<RestoreResult> {
    // #2452 — `trashId` lands inside `cat`/`mv`/`rm -rf` command strings
    // below. Same strict basename check the sibling `purgeTrash` applies:
    // no separators, no traversal, no shell metacharacters.
    assertTrashId(trashId);
    const agent = await agentManager.ensureAgent(nodeName);
    // A restore may target an entry that is still in a legacy location, so
    // sweep first and then look in exactly one place.
    await ensureTrashRootMigrated(nodeName);
    const trashDirArg = trashEntryArg(trashId);

    // Read manifest. Manifest is the source of truth for original
    // paths because the service may have referenced a yaml file
    // outside SYSTEMD_DIR.
    const m = await agent.sendCommand('exec', {
        command: `cat ${trashEntryArg(`${trashId}/.manifest.json`)} 2>/dev/null`,
    });
    let manifest: {
        service?: string;
        originalYamlPath?: string | null;
        originalKubePath?: string;
        installedTemplate?: InstalledTemplateRecord | null;
    };
    try {
        manifest = JSON.parse(((m?.stdout ?? '') as string) || '{}');
    } catch {
        throw new Error(`Trash entry ${trashId} is missing or has a corrupt manifest — restore manually`);
    }
    if (!manifest.service) {
        throw new Error(`Trash entry ${trashId} has no service name in manifest`);
    }

    await moveTrashedFilesBack(agent, trashId, manifest.originalYamlPath ?? null);
    // Wipe the now-empty trash dir.
    await agent.sendCommand('exec', { command: `rm -rf ${trashDirArg}` });

    // #2863 — the record went into the trash with the files; it comes back
    // with them, before anything reads `installedTemplates` again.
    await putBackInstalledTemplateRecord(manifest.service, manifest.installedTemplate);

    await reloadDaemon(nodeName);
    await refreshAgent(nodeName);
    backupQuadlets(nodeName);

    // Re-provision the neighbours the delete cleaned up. Failures are
    // recorded as standing findings (same store the install runner
    // writes) so a restored-but-unprovisioned service is visible in
    // diagnose instead of quietly missing its login path.
    const capabilityFailures = await emitFeatureRestored(manifest.service);
    await recordCapabilityOutcome(manifest.service, capabilityFailures, 'restoring');

    // #2756 — the delete stopped the unit, so moving the files back and
    // reloading systemd leaves a registered-but-dead service: `list_services`
    // shows it, nothing runs it, and the operator has to guess whether it is
    // booting or broken. Undoing a delete means the service runs again, so
    // start it here and wait the way the deploy path waits. `startup.state`
    // carries the honest answer — `active`, or `converging` when the pod is
    // still pulling/booting past the bound, which a caller polls out of.
    const startup = await startAndWaitForActive(nodeName, manifest.service);

    logger.info(
        'ServiceManager',
        `Restored ${manifest.service} from trash on ${nodeName} (startup: ${startup.state})`,
    );
    return { service: manifest.service, capabilityFailures, startup };
}

/** Permanently delete one trash entry, or all entries older than the
 *  given retention (in milliseconds). */
export async function purgeTrash(nodeName: string, opts: { trashId?: string; olderThanMs?: number }): Promise<{ purged: string[] }> {
    const agent = await agentManager.ensureAgent(nodeName);
    if (opts.trashId) {
        // Strict basename — no traversal allowed.
        assertTrashId(opts.trashId);
        await agent.sendCommand('exec', { command: `rm -rf ${trashEntryArg(opts.trashId)}` });
        logger.info('ServiceManager', `Purged trash entry ${opts.trashId} on ${nodeName}`);
        return { purged: [opts.trashId] };
    }
    if (opts.olderThanMs !== undefined) {
        const list = await ServiceListing.listTrashedServices(nodeName);
        const now = Date.now();
        const toPurge = list.filter(e => {
            const ts = Date.parse(e.deletedAt);
            if (!isFinite(ts)) return false;
            return (now - ts) > opts.olderThanMs!;
        });
        for (const entry of toPurge) {
            await agent.sendCommand('exec', { command: `rm -rf ${trashEntryArg(entry.id)}` });
        }
        if (toPurge.length > 0) {
            logger.info('ServiceManager', `Purged ${toPurge.length} trash entr${toPurge.length === 1 ? 'y' : 'ies'} older than ${Math.round(opts.olderThanMs / 86_400_000)}d on ${nodeName}`);
        }
        return { purged: toPurge.map(e => e.id) };
    }
    return { purged: [] };
}
