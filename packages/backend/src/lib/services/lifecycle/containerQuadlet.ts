/**
 * `.container` Quadlet handling + image pre-pull (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: the #2174 reconcile that retires
 * the `.kube`/`.yml` shadowing a GPU `.container` unit, the #2618 recreate
 * decision, the direct `.container` write-back path, and the pre-start image
 * pull.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import yaml from 'js-yaml';
import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { buildExpectedContainerNames } from '../containerNameMatcher';
import type { PodLikeDoc } from '../containerNameMatcher';
import {
    containerNameForQuadlet,
    decideContainerRecreate,
    isSafeShellName,
    parseExecStartArgv,
    parseInspectFacts,
    readUnitDirective,
    type RecreateDecision,
} from '../containerQuadletState';
import { isServiceActive, reloadDaemon, restartService, startService } from './units';
import { SYSTEMD_DIR, backupQuadlets, readExistingQuadletFile, writeFile } from './quadletFiles';

/** Is a `.container` Quadlet on disk for this service? (#2174/#2618) */
export async function hasContainerQuadletUnit(nodeName: string, name: string): Promise<boolean> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', {
            command: `test -f ~/${SYSTEMD_DIR}/${name}.container && echo present || echo absent`,
        });
        return (res?.stdout ?? '').trim() === 'present';
    } catch {
        return false;
    }
}

/**
 * Does the container that's actually running still match the `.container`
 * Quadlet on disk? (#2618 — the reasoning lives in containerQuadletState.ts.)
 * Must run AFTER the daemon-reload so `systemctl show` reports the unit
 * regenerated from the current file. Any failure ⇒ `recreate: true`.
 */
export async function decideContainerQuadletRecreate(nodeName: string, name: string): Promise<RecreateDecision> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        const unitContent = (await readExistingQuadletFile(nodeName, `${name}.container`)) ?? '';
        const containerName = containerNameForQuadlet(name, unitContent);
        const imageRef = readUnitDirective(unitContent, 'Image');
        if (!isSafeShellName(containerName)) {
            return { recreate: true, reason: 'the unit names a container this cannot inspect safely' };
        }

        const show = await agent.sendCommand('exec', {
            command: `systemctl --user show ${name}.service --property=ExecStart`,
        });
        const inspect = await agent.sendCommand('exec', {
            command: `podman inspect --format '{{.State.Running}}|{{.Image}}|{{json .Config.CreateCommand}}' ${containerName} 2>/dev/null || true`,
        });

        let imageId = '';
        if (isSafeShellName(imageRef)) {
            const img = await agent.sendCommand('exec', {
                command: `podman image inspect --format '{{.Id}}' ${imageRef} 2>/dev/null || true`,
            });
            imageId = String(img?.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
        }

        return decideContainerRecreate({
            desired: { execStartArgv: parseExecStartArgv(String(show?.stdout ?? '')), imageId },
            running: parseInspectFacts(String(inspect?.stdout ?? '')),
            unitActive: await isServiceActive(nodeName, name),
        });
    } catch (e) {
        logger.warn('ServiceManager', `${name}: could not compare the running container to its .container unit:`, e);
        return { recreate: true, reason: 'the running container could not be inspected' };
    }
}

/**
 * Reconcile a `.container` GPU Quadlet against the shadowing `.kube`/`.yml`
 * that `deployKubeService` writes on every deploy (#2174).
 *
 * A template's post-deploy.py can swap a service to a `.container` unit so
 * `AddDevice=nvidia.com/gpu=all` survives (ollama's CDI fixup, #1026 —
 * `podman kube play` silently drops `resources.limits.nvidia.com/gpu` on
 * rootless). But `deployKubeService` unconditionally (re)writes
 * `${name}.kube` + `${name}.yml` earlier in the deploy. **Both units
 * generate `${name}.service`** — and systemd's generator may pick the
 * `.kube` (kube-play, CPU) over the `.container`, so ollama silently drops
 * to CPU with no error, and even when the `.container` does win, the old
 * CPU container keeps the container name so a plain `start`/`restart`
 * never re-creates it with the CDI device.
 *
 * Idempotent reconcile, guarded to nodes where the `.container` is in use:
 *   1. If no `${name}.container` on disk → no-op (every normal kube deploy).
 *   2. Move the shadowing `.kube`/`.yml` this deploy just wrote into the
 *      trash bucket so `${name}.service` unambiguously comes from the
 *      `.container` (recoverable, mirrors soft-delete).
 *   3. daemon-reload, stop the unit, **force-remove** every plausible
 *      container name (a plain restart leaves the old CPU container by
 *      name), then start — so the container is recreated with the CDI
 *      device. Matches the manual restore documented in #2174.
 *
 * Best-effort: any agent failure is logged and swallowed — a botched
 * reconcile must not fail the deploy (the service is already running).
 */
export async function reconcileContainerQuadletShadow(
    nodeName: string,
    name: string,
    yamlName: string,
    yamlContent: string,
    onProgress?: (message: string) => void,
): Promise<void> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);

        // Guard: only act when a `.container` unit is actually on disk.
        // Absent → this is an ordinary `.kube` deploy; nothing to shadow.
        if (!await hasContainerQuadletUnit(nodeName, name)) return;

        onProgress?.(`${name}: a .container GPU Quadlet is in use — retiring the shadowing .kube/.yml.`);
        logger.info('ServiceManager', `${name}: reconciling .container over shadowing .kube/.yml (#2174)`);

        // Move the shadowing units into the trash bucket (recoverable),
        // mirroring soft-delete's "move, don't rm".
        const trashStamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = `~/${SYSTEMD_DIR}/.trash/${trashStamp}-${name}-shadow`;
        await agent.sendCommand('exec', { command: `mkdir -p '${trashDir}'` });
        await agent.sendCommand('exec', {
            command: `mv -f ~/${SYSTEMD_DIR}/${name}.kube '${trashDir}/' 2>/dev/null || true`,
        });
        await agent.sendCommand('exec', {
            command: `mv -f ~/${SYSTEMD_DIR}/${yamlName} '${trashDir}/' 2>/dev/null || true`,
        });

        await reloadDaemon(nodeName);

        // #2618 — the force-recreate below is what makes the GPU device
        // stick, and it is also what evicts every bit of warm state the
        // container holds (ollama's VRAM-resident models). Only pay it when
        // the running container isn't already the one this unit describes.
        // The check errs toward recreating: see containerQuadletState.ts.
        const decision = await decideContainerQuadletRecreate(nodeName, name);
        if (!decision.recreate) {
            onProgress?.(`${name}: left running, NOT recreated — ${decision.reason}. Warm in-container state (e.g. ollama's VRAM-resident models) survives this deploy.`);
            logger.info('ServiceManager', `${name}: .container matches the running container — skipping the force-recreate (#2618)`);
            return;
        }
        onProgress?.(`${name}: force-recreating the container — ${decision.reason}.`);

        // Force-recreate: stop the unit, remove every plausible container
        // name (the old CPU container survives a restart by holding the
        // name), then start so the `.container` unit recreates it with the
        // CDI device. Candidate names come from the shadowing pod spec
        // plus the standard Quadlet name shapes (`ollama-ollama` etc.).
        try {
            await agent.sendCommand('exec', { command: `systemctl --user stop ${name}.service` });
        } catch { /* may already be stopped */ }

        let podDocs: PodLikeDoc[] = [];
        try {
            podDocs = (yaml.loadAll(yamlContent) as PodLikeDoc[]).filter(Boolean);
        } catch { /* malformed yaml → fall back to the standard name shapes */ }
        const candidates = buildExpectedContainerNames(name, podDocs);
        for (const cname of candidates) {
            await agent.sendCommand('exec', { command: `podman rm -f ${cname} 2>/dev/null || true` });
        }

        try {
            await agent.sendCommand('exec', { command: `systemctl --user reset-failed ${name}.service` });
        } catch { /* unit may not be in failed state */ }
        await startService(nodeName, name);

        onProgress?.(`${name}: container force-recreated from the .container Quadlet — GPU device should now be attached.`);
    } catch (e) {
        logger.warn('ServiceManager', `${name}: .container shadow reconcile failed (non-fatal):`, e);
    }
}

/**
 * Write back an edited single-container `.container` Quadlet and
 * redeploy it (#1778).
 *
 * Unlike a `.kube` Quadlet — which is a thin wrapper that
 * `deployKubeService` regenerates around a separate pod-spec `.yml` —
 * a `.container` unit IS the deploy artifact (the ollama GPU fixup,
 * #1026, swaps to `.container` so `AddDevice=nvidia.com/gpu=all`
 * survives). So the read/update contract for `.container` is: the
 * caller edits the `.container` unit body itself (the `kubeContent`
 * from `getServiceFiles`) and we write it straight back, reload the
 * daemon, and restart. There is no pod spec, no port-collision
 * pre-flight on a `.yml` (the unit body owns its own `PublishPort=`),
 * and no schema-version stamping.
 */
export async function deployContainerQuadlet(
    nodeName: string,
    name: string,
    containerContent: string,
) {
    await writeFile(nodeName, `${name}.container`, containerContent);
    await reloadDaemon(nodeName);
    // Restart so the regenerated unit takes effect. `.container` units
    // pull their own image on start (Image= directive), so no separate
    // pre-pull step is needed here.
    await restartService(nodeName, name);
    backupQuadlets(nodeName);
}

/**
 * Pull every hostPort declared in a kube YAML. Tolerates malformed YAML
 * (returns empty rather than throwing) so a parse error never blocks a
 * deploy via the collision check.
 */
export async function prePullImages(
    nodeName: string,
    images: string[],
    onProgress?: (image: string, imageIndex: number, total: number, event: import('../../agent/handler').PullProgressEvent) => void
) {
    const agent = await agentManager.ensureAgent(nodeName);
    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        try {
            logger.info('ServiceManager', `Pre-pulling image: ${image}`);
            await agent.pullImage(image, onProgress ? (evt) => onProgress(image, i, images.length, evt) : undefined);
        } catch (e) {
            logger.warn('ServiceManager', `Failed to pre-pull ${image} (will retry on start):`, e);
        }
    }
}
