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

/**
 * Soft-delete a service: stop the unit, then *move* its .kube and .yml
 * files into ~/.config/containers/systemd/.trash/<ts>-<name>/ instead
 * of deleting them. The operator (or an MCP client) can `restore_from_trash`
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

    // Move the files into the trash bucket. ISO-8601 with no colons in
    // the name so it sorts by timestamp and survives shells that hate
    // colons in paths.
    const trashStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = `~/${SYSTEMD_DIR}/.trash/${trashStamp}-${serviceName}`;
    await agent.sendCommand('exec', { command: `mkdir -p '${trashDir}'` });

    // Move kube file
    await agent.sendCommand('exec', {
        command: `mv -f ~/${SYSTEMD_DIR}/${serviceName}.kube '${trashDir}/' 2>/dev/null || true`
    });

    // Move yaml file
    if (yamlPath) {
        const resolvedYaml = yamlPath.startsWith('/') ? yamlPath : `~/${yamlPath}`;
        await agent.sendCommand('exec', {
            command: `mv -f ${resolvedYaml} '${trashDir}/' 2>/dev/null || true`,
        });
    }

    // Stash a small manifest so restore knows the original yaml path
    // even if it lived outside the systemd dir (legacy migrations did).
    const manifest = JSON.stringify({
        service: serviceName,
        deletedAt: new Date().toISOString(),
        originalYamlPath: yamlPath || null,
        originalKubePath: `~/${SYSTEMD_DIR}/${serviceName}.kube`,
    });
    await agent.sendCommand('exec', {
        command: `printf '%s' ${JSON.stringify(manifest)} > '${trashDir}/.manifest.json'`,
    });

    await reloadDaemon(nodeName);

    // Clear failed state
    try {
        await agent.sendCommand('exec', { command: `systemctl --user reset-failed ${serviceName}.service` });
    } catch { /* unit may not be in failed state */ }

    await refreshAgent(nodeName);
    backupQuadlets(nodeName);

    await finishUninstall(serviceName, lastKnownVariables, emitEvents);

    logger.info('ServiceManager', `Soft-deleted ${serviceName} on ${nodeName} → ${trashDir}`);
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
    const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
    const trashDir = `${trashRoot}/${trashId}`;

    // Read manifest. Manifest is the source of truth for original
    // paths because the service may have referenced a yaml file
    // outside SYSTEMD_DIR.
    const m = await agent.sendCommand('exec', {
        command: `cat '${trashDir}/.manifest.json' 2>/dev/null`,
    });
    let manifest: { service?: string; originalYamlPath?: string | null; originalKubePath?: string };
    try {
        manifest = JSON.parse(((m?.stdout ?? '') as string) || '{}');
    } catch {
        throw new Error(`Trash entry ${trashId} is missing or has a corrupt manifest — restore manually`);
    }
    if (!manifest.service) {
        throw new Error(`Trash entry ${trashId} has no service name in manifest`);
    }

    const kubePath = manifest.originalKubePath || `~/${SYSTEMD_DIR}/${manifest.service}.kube`;
    const yamlPath = manifest.originalYamlPath
        ? (manifest.originalYamlPath.startsWith('/') ? manifest.originalYamlPath : `~/${manifest.originalYamlPath}`)
        : null;

    await agent.sendCommand('exec', {
        command: `mv '${trashDir}/${manifest.service}.kube' ${kubePath} 2>/dev/null || true`,
    });
    if (yamlPath) {
        // The yaml lives in the trash dir under its basename.
        const yamlBasename = manifest.originalYamlPath?.split('/').pop();
        if (yamlBasename) {
            await agent.sendCommand('exec', {
                command: `mv '${trashDir}/${yamlBasename}' ${yamlPath} 2>/dev/null || true`,
            });
        }
    }
    // Wipe the now-empty trash dir.
    await agent.sendCommand('exec', { command: `rm -rf '${trashDir}'` });

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
    const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
    if (opts.trashId) {
        // Strict basename — no traversal allowed.
        assertTrashId(opts.trashId);
        await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${opts.trashId}'` });
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
            await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${entry.id}'` });
        }
        if (toPurge.length > 0) {
            logger.info('ServiceManager', `Purged ${toPurge.length} trash entr${toPurge.length === 1 ? 'y' : 'ies'} older than ${Math.round(opts.olderThanMs / 86_400_000)}d on ${nodeName}`);
        }
        return { purged: toPurge.map(e => e.id) };
    }
    return { purged: [] };
}
