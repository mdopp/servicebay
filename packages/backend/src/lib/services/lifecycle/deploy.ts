/**
 * The kube deploy sequence (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`. This is the orchestrator: it
 * calls the predecessor migration, the port-collision pre-flight, the file
 * writes, the pre-start hooks, the start-vs-restart decision, post-deploy and
 * the `.container` shadow reconcile — each of which now lives in its own
 * sibling module.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { updateConfig } from '../../config';
import { readManifestAnnotations } from '../../template/contract';
import { injectServiceDirectives } from '../quadletDirectives';
import { ServiceListing } from '../serviceListing';
import { writeExtraConfigFiles } from '../extraConfigFiles';
import { migratePredecessors, runMigrationScript } from './migrations';
import { runPostDeployScript } from './postDeploy';
import { fixVolumeOwnership, runPreStartHooks } from './preStartHooks';
import {
    hasContainerQuadletUnit,
    prePullImages,
    reconcileContainerQuadletShadow,
} from './containerQuadlet';
import {
    ensurePodmanSocket,
    ensureUnprivilegedPorts,
    isServiceActive,
    readServiceRunState,
    reloadDaemon,
    restartService,
    startService,
    waitForRestartSettled,
} from './units';
import { backupQuadlets, readExistingQuadletFile, writeFile } from './quadletFiles';

/**
 * Validate that template config files match sent extraFiles (sanity check).
 */
async function validateTemplateConfigFiles(
    name: string,
    extraFiles?: { path: string; content: string }[],
): Promise<void> {
    try {
        const { getTemplateConfigFiles } = await import('@/lib/registry');
        const expected = await getTemplateConfigFiles(name);
        if (expected.length > 0) {
            const got = new Set((extraFiles ?? []).map(f => f.path.split('/').pop()).filter(Boolean));
            const missing = expected.filter(e => !got.has(e.filename));
            if (missing.length > 0) {
                throw new Error(
                    `Template "${name}" ships ${expected.length} mustache config file(s) but ${missing.length} weren't sent to the deploy step:\n  ${missing.map(m => m.filename).join(', ')}\n\n` +
                    `This usually means the wizard's resolver couldn't map a config file to a hostPath — check that the pod manifest declares servicebay.config-mount: <mountPath> and that the mountPath has a matching volume.`,
                );
            }
        }
        const relative = (extraFiles ?? []).filter(f => !f.path.startsWith('/'));
        if (relative.length > 0) {
            throw new Error(
                `Template "${name}" extraFiles include ${relative.length} relative path(s) — the agent will resolve these under ~ and the file will land in the wrong place:\n  ${relative.map(f => f.path).join('\n  ')}\n\n` +
                `This usually means the wizard's resolver substituted a Mustache placeholder (e.g. {{DATA_DIR}}) with junk before parsing. Check that targetPath preserves the {{...}} placeholder until deploy-time render.`,
            );
        }
    } catch (e) {
        if (e instanceof Error && e.message.startsWith('Template "')) throw e;
        logger.debug('ServiceManager', 'Could not verify template configFiles parity:', e);
    }
}

/**
 * Format image pull progress updates for the install log.
 */
function formatImagePullProgress(
    image: string,
    idx: number,
    total: number,
    evt: { id?: string; status?: string; total?: number; current?: number },
): string | null {
    if (!evt.id || !evt.status) return null;
    if (evt.total && evt.current !== undefined) {
        const pct = Math.round(evt.current / evt.total * 100);
        const currentMB = (evt.current / 1048576).toFixed(1);
        const totalMB = (evt.total / 1048576).toFixed(1);
        return `Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status} ${currentMB} MB / ${totalMB} MB (${pct}%)`;
    }
    return `Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status}`;
}

export async function deployKubeService(
    nodeName: string,
    name: string,
    kubeContent: string,
    yamlContent: string,
    yamlName: string,
    extraFiles?: { path: string; content: string }[],
    onProgress?: (message: string) => void,
    postDeployScript?: string,
    postDeployEnv?: Record<string, string>,
    /**
     * Ordered chain of migration scripts to run before the new yaml
     * lands. Built client-side by `selectMigrationChain` from the
     * delta between `config.installedTemplates[name].schemaVersion`
     * and the target template's schema-version. Each script is
     * pre-rendered (Mustache placeholders already substituted) so
     * the server only has to execute. Non-zero exit on any step
     * aborts the deploy. See #352 phase 3.
     */
    migrations?: { filename: string; fromVersion: number; toVersion: number; content: string }[],
    /**
     * #2703 — does `extraFiles` carry the template's COMPLETE resolved
     * artifact set? Only the install runner can say yes (it POSTs the
     * whole of `resolveTemplateArtifacts`'s output). It licenses the
     * delivered-files prune pass; every other entry point delivers a
     * subset and must not be read as "everything that still exists".
     */
    completeDelivery = false,
) {
    // Migrate any pre-rename predecessor units first so their host-port
    // ownership is released before the port-collision pre-flight runs.
    await migratePredecessors(nodeName, name, onProgress);

    // Pre-flight: refuse to deploy if the YAML claims a host port that
    // another service on the same node already owns. Without this check,
    // the second deploy "succeeds" but the unit fails to start because the
    // bind() races; users only notice when the new service stays
    // permanently inactive in the dashboard.
    const collisions = await ServiceListing.findHostPortCollisions(nodeName, name, yamlContent);
    if (collisions.length > 0) {
        const detail = collisions
            .map(c => `port ${c.hostPort} already in use by ${c.serviceName}`)
            .join('; ');
        throw new Error(`Port collision on node "${nodeName}": ${detail}. Change the host port and retry.`);
    }

    // Inject the default systemd directives (TimeoutStartSec for slow
    // image pulls + Restart=on-failure with exponential backoff) into
    // every .kube unit, single-image or multi-image. The previous
    // multi-image-only gate was a leftover from when only the
    // TimeoutStartSec was injected; it caused single-image services
    // (radicale, filebrowser, nginx, …) to land *without* any
    // restart directives, so a transient image-pull failure or any
    // crash put the unit permanently in `failed` state with no auto-
    // recovery. injectServiceDirectives is idempotent per-directive,
    // so re-deploys never duplicate keys.
    kubeContent = injectServiceDirectives(kubeContent);

    const images = ServiceListing.extractImages(yamlContent);

    // Run the template's migration chain BEFORE the new yaml lands so
    // the existing service (still on the old unit) doesn't already see
    // moved/transformed data while the migration is in flight. The
    // chain is fail-fast: any non-zero exit throws and the deploy
    // never touches the existing unit. See #352 phase 3.
    if (migrations && migrations.length > 0) {
        onProgress?.(`Running ${migrations.length} migration step(s) for ${name}...`);
        for (const m of migrations) {
            await runMigrationScript(nodeName, name, m, postDeployEnv ?? {}, onProgress);
        }
    }

    // #1813 — `systemctl start` is a no-op on an already-active unit, so a
    // re-deploy that changed the pod spec (e.g. a removed container) would
    // write the new render to disk but keep the OLD topology running until
    // a manual restart. Capture the on-disk content BEFORE overwriting so
    // we can tell whether this deploy actually changed the spec and force a
    // restart in that case. A variable-only refresh that produces identical
    // files still skips the restart (best-effort: a read failure → treat as
    // changed, so we err toward applying the new render).
    const prevYaml = await readExistingQuadletFile(nodeName, yamlName);
    const prevKube = await readExistingQuadletFile(nodeName, `${name}.kube`);
    const specChanged = prevYaml !== yamlContent || prevKube !== kubeContent;

    await writeFile(nodeName, yamlName, yamlContent);
    await writeFile(nodeName, `${name}.kube`, kubeContent);
    await ensurePodmanSocket(nodeName);

    // Defensive: validate template config files sanity.
    await validateTemplateConfigFiles(name, extraFiles);

    // Write extra config files (e.g. Authelia configuration.yml) to the
    // node filesystem. Failures are FATAL (see writeExtraConfigFiles).
    //
    // #2590 — the manifest itself says which of those files ServiceBay may
    // only SEED. Read from the rendered pod YAML this deploy is about to
    // apply, so every entry point (install runner, MCP `deploy_service`,
    // the HTTP route) is covered by one rule and no caller can forget to
    // pass the flag. `readManifestAnnotations` (permissive) rather than
    // `parseTemplateManifest` on purpose: a manifest missing some
    // UNRELATED required annotation must not silently drop this
    // protection.
    //
    // #2703 — a complete delivery runs even when it carries zero files,
    // because "the template no longer ships this file" is exactly the
    // case the prune pass exists for; the empty-delivery circuit breaker
    // lives in the prune itself.
    if (extraFiles?.length || completeDelivery) {
        const agent = await agentManager.ensureAgent(nodeName);
        const seedOnly = new Set(readManifestAnnotations(yamlContent).seedOnlyConfigs ?? []);
        await writeExtraConfigFiles(agent, name, extraFiles ?? [], seedOnly, { nodeName, completeDelivery });
    }

    // Ensure unprivileged port binding if any port < 1024 is used
    if (ServiceListing.hasPrivilegedPorts(yamlContent)) {
        await ensureUnprivilegedPorts(nodeName);
    }

    await reloadDaemon(nodeName);

    // Pre-pull all images before starting to avoid systemd timeout
    await prePullImages(nodeName, images, onProgress ? (image, idx, total, evt) => {
        const msg = formatImagePullProgress(image, idx, total, evt);
        if (msg) onProgress(msg);
    } : undefined);

    // Fix volume ownership for containers running as non-root UIDs
    await fixVolumeOwnership(nodeName, yamlContent);

    // Run pre-start hooks (e.g. initialize databases with known credentials)
    await runPreStartHooks(nodeName, name, yamlContent);

    // Attempt start, but don't fail deployment if start fails (user can check logs).
    // #1813 — if the rendered spec changed AND the unit is already active,
    // `start` alone won't re-read the new pod spec (it's a no-op on a live
    // unit), so restart to actually apply the changed topology. First
    // install (inactive) or an unchanged re-render falls through to a plain
    // start.
    //
    // #2406 — the restart is `--no-block`: systemd returns as soon as the
    // job is QUEUED. Everything after this point (above all the template's
    // post-deploy script) used to run while the pod was still tearing down
    // and coming back, so a post-deploy that queried its own pod hit a
    // moving target. Wait for the unit to actually be up again — a real
    // readiness check on a NEW invocation, not a sleep — before continuing.
    // The plain-start path (first install / unchanged render) is untouched:
    // no wait is added there, since nothing was torn down.
    try {
        // #2618 — for a service that runs from a `.container` Quadlet the
        // `.kube`/`.yml` written above is a shadow that
        // reconcileContainerQuadletShadow retires a few steps below, so
        // `specChanged` is structurally always true here (last deploy
        // trashed those very files) and this restart fired on every single
        // deploy — evicting ollama's warm VRAM cache before post-deploy had
        // even run. The `.container` unit, not the pod spec, is what runs;
        // the reconcile owns the restart decision for it and makes it on
        // desired-vs-actual evidence.
        const containerQuadletInUse = await hasContainerQuadletUnit(nodeName, name);
        const alreadyActive = specChanged && !containerQuadletInUse && (await isServiceActive(nodeName, name));
        if (alreadyActive) {
            onProgress?.(`Pod spec changed — restarting ${name} to apply the new topology...`);
            const before = await readServiceRunState(nodeName, name);
            await restartService(nodeName, name);
            const settle = await waitForRestartSettled(nodeName, name, before);
            const secs = (settle.waitedMs / 1000).toFixed(1);
            if (settle.settled) {
                onProgress?.(`${name} restart settled after ${secs}s — unit active/running; continuing (post-deploy, if any, runs AFTER the restart).`);
            } else if (settle.reason === 'failed') {
                onProgress?.(`⚠️ ${name} failed to come back up after the restart (systemd reports ${settle.state.activeState}/${settle.state.subState || '?'} after ${secs}s). Continuing anyway — anything that queries this pod next may not find it.`);
                logger.warn('ServiceManager', `Service ${name} restart ended in failed state`, settle.state);
            } else {
                onProgress?.(`⚠️ ${name} did not report active within ${secs}s of the restart (last state: ${settle.state.activeState || 'unreadable'}/${settle.state.subState || '?'}). Continuing anyway — anything that queries this pod next may not find it.`);
                logger.warn('ServiceManager', `Service ${name} restart readiness wait timed out`, settle.state);
            }
        } else {
            await startService(nodeName, name);
        }
    } catch (e) {
        logger.warn('ServiceManager', `Service ${name} deployed but start failed:`, e);
    }

    // Parse the manifest once — both the readiness wait (#613) and the
    // requiresApi gate (#588) read from it. The yamlContent passed in
    // is already Mustache-rendered, so probe values are concrete.
    const { tryParseTemplateManifest } = await import('@/lib/template/contract');
    const { assertApiCompat } = await import('@/lib/template/apiVersions');
    const manifest = tryParseTemplateManifest(yamlContent);

    // #628 retired the per-template readiness-probe gate that used
    // to run here. Continuous health is now the single source of
    // truth: the install runner's settleWait reads `twin.health.
    // ready` (populated by the service-health poller from the
    // `servicebay.healthcheck` annotation) AFTER post-deploy runs.
    // Post-deploy scripts that need to block on their own service
    // being responsive still do so via in-script helpers (e.g.
    // ollama's wait_for_ready, immich's wait_pod_running) which
    // are local to each script and don't depend on ServiceBay's
    // install layer.

    // Run the template's post-deploy.py if it shipped one. Convention:
    // see lib/registry.ts:getTemplatePostDeployScript for the protocol.
    // The script can talk to the now-running container directly (e.g.
    // POST to its /init on the host port) or call ServiceBay's own
    // admin endpoints. Stdout streams to onProgress; lines starting with
    // `__SB_CREDENTIAL__ ` are the structured credential markers the
    // wizard parses for the SAVE-THESE-NOW banner.
    if (postDeployScript) {
        // requiresApi gate (#588): if the template's manifest declares
        // a `servicebay.requires-api.<name>` annotation that this core
        // can't satisfy, refuse to invoke post-deploy.py instead of
        // letting it silently break against a renamed endpoint. The
        // unit is already running and stays running — only the script
        // is skipped, with a clear error in the install log.
        if (manifest?.requiresApi) {
            assertApiCompat(name, manifest.requiresApi);
        }
        await runPostDeployScript(nodeName, name, postDeployScript, postDeployEnv ?? {}, onProgress);
    }

    // #2174 — a post-deploy.py may swap this service to a `.container`
    // GPU Quadlet (ollama's CDI fixup, #1026). deployKubeService just
    // wrote `${name}.kube`+`${name}.yml` above; both units generate
    // `${name}.service`, and systemd may pick the `.kube` (kube-play,
    // no CDI device) over the `.container` — silently dropping ollama
    // to CPU. Reconcile: if a `.container` unit now exists, retire the
    // shadowing `.kube`/`.yml` and force-recreate the container so it
    // picks up the CDI device. No-op for every non-`.container` deploy.
    await reconcileContainerQuadletShadow(nodeName, name, yamlName, yamlContent, onProgress);

    // Stamp the template's schema version so future re-deploys can
    // detect breaking-change deltas vs. the version that's actually
    // running on the box. See #353 / #354. Best-effort: a failure
    // here just means the breaking-change banner can't fire on the
    // next deploy, which is no worse than the pre-tracking state.
    try {
        const { parseTemplateSchemaVersion } = await import('@/lib/templateSchemaVersion');
        const schemaVersion = parseTemplateSchemaVersion(yamlContent);
        await updateConfig({
            installedTemplates: {
                [name]: {
                    schemaVersion,
                    installedAt: new Date().toISOString(),
                },
            },
        });
    } catch (e) {
        logger.warn('ServiceManager', `Could not stamp installedTemplates[${name}]:`, e);
    }

    backupQuadlets(nodeName);

    // Create health check for the new service if one doesn't exist
    try {
        const { HealthStore } = await import('../../health/store');
        const checks = HealthStore.getChecks();
        const alreadyMonitored = checks.some(c =>
            (c.type === 'service' && c.target === name) ||
            (c.name === `Service: ${name}`)
        );
        if (!alreadyMonitored) {
            const crypto = await import('crypto');
            HealthStore.saveCheck({
                id: crypto.randomUUID(),
                name: `Service: ${name}`,
                type: 'service',
                target: name,
                interval: 60,
                enabled: true,
                created_at: new Date().toISOString(),
                nodeName: nodeName !== 'Local' ? nodeName : undefined,
            });
            logger.info('ServiceManager', `Created health check for ${name}`);
        }
    } catch (e) {
        logger.warn('ServiceManager', `Failed to create health check for ${name}:`, e);
    }
}
