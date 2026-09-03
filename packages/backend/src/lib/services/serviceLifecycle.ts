/**
 * Service lifecycle operations (#589 follow-up) — the write-path facade.
 *
 * Extracted from the monolithic ServiceManager.ts via the reviewer's planned
 * split. Contains every mutating operation on managed services: deploy /
 * start / stop / restart / delete / rename / save.
 *
 * #2741 split the 2,167-line implementation into task-scoped modules under
 * `./lifecycle/`, one per concern, with the internals moved verbatim:
 *
 *   units.ts           systemd start/stop/restart + the restart-settle wait
 *   quadletFiles.ts    unit-file read/write, save/remove, quadlet backup
 *   migrations.ts      predecessor cleanup + the template migration chain
 *   postDeploy.ts      post-deploy.py transport, env + audit
 *   preStartHooks.ts   volume ownership, FileBrowser DB, the HA self-heal
 *   containerQuadlet.ts  `.container` reconcile / recreate / pre-pull
 *   deploy.ts          the kube deploy sequence that calls all of the above
 *   trash.ts           soft-delete / restore / purge + capability events
 *   rename.ts          rename + unit Description=
 *   imageRefresh.ts    image walk + the update-and-restart cycle
 *
 * **This file stays the only door.** `ServiceManager` re-aliases the statics
 * below, and the depcruise rule `service-manager-single-mutation-path` forbids
 * importing this module OR anything under `./lifecycle/` from outside
 * `src/lib/services/` — so the multi-path-mutation bug #589 cleaned up cannot
 * come back through a split-off module. Add behaviour in the module that owns
 * the concern; add a line here only when a new verb appears.
 */

import { deployKubeService } from './lifecycle/deploy';
import { updateAndRestartService } from './lifecycle/imageRefresh';
import { STACK_MIGRATIONS } from './lifecycle/migrations';
import { buildPostDeployEnvLines } from './lifecycle/postDeploy';
import { renameService, updateServiceDescription } from './lifecycle/rename';
import { runHomeAssistantHook, runPreStartHooks } from './lifecycle/preStartHooks';
import { deleteService, purgeTrash, restoreTrashedService } from './lifecycle/trash';
import {
    deployContainerQuadlet,
    decideContainerQuadletRecreate,
    hasContainerQuadletUnit,
    prePullImages,
    reconcileContainerQuadletShadow,
} from './lifecycle/containerQuadlet';
import {
    deployService,
    readExistingQuadletFile,
    removeService,
    saveService,
    writeFile,
} from './lifecycle/quadletFiles';
import {
    ensurePodmanSocket,
    ensureUnprivilegedPorts,
    isServiceActive,
    readServiceRunState,
    reloadDaemon,
    restartService,
    startService,
    stopService,
    waitForRestartSettled,
} from './lifecycle/units';

// Re-exported so the shape callers already import from this module is
// unchanged by the #2741 split.
export { RESTART_SETTLE_TUNING, type ServiceRunState } from './lifecycle/units';
export { collectImagesFromKubeYaml } from './lifecycle/imageRefresh';

// Companion config/asset file delivery lives in its own module (#2590):
// `./extraConfigFiles`. Import it from there — this file deliberately keeps no
// re-export, so there is exactly one path to it and knip can see the truth.

export class ServiceLifecycle {
    // ── systemd unit control (./lifecycle/units) ──────────────────────────
    static startService = startService;
    static stopService = stopService;
    static restartService = restartService;
    static reloadDaemon = reloadDaemon;
    static isServiceActive = isServiceActive;
    static readServiceRunState = readServiceRunState;
    static waitForRestartSettled = waitForRestartSettled;
    static ensurePodmanSocket = ensurePodmanSocket;
    static ensureUnprivilegedPorts = ensureUnprivilegedPorts;

    // ── quadlet files on the node (./lifecycle/quadletFiles) ──────────────
    static readExistingQuadletFile = readExistingQuadletFile;
    static writeFile = writeFile;
    static deployService = deployService;
    static removeService = removeService;
    static saveService = saveService;

    // ── install / upgrade (./lifecycle/deploy, migrations, postDeploy) ────
    static readonly STACK_MIGRATIONS: Record<string, string[]> = STACK_MIGRATIONS;
    static deployKubeService = deployKubeService;
    /** Internal to the deploy path; kept on the facade for
     *  `serviceLifecycle.postDeployReadToken.test.ts`. */
    static buildPostDeployEnvLines = buildPostDeployEnvLines;

    // ── pre-start hooks (./lifecycle/preStartHooks) ───────────────────────
    static runHomeAssistantHook = runHomeAssistantHook;
    /** Internal to the deploy path; kept on the facade for
     *  `serviceLifecycle.homeAssistantHook.test.ts`. */
    static runPreStartHooks = runPreStartHooks;

    // ── `.container` Quadlets (./lifecycle/containerQuadlet) ──────────────
    static reconcileContainerQuadletShadow = reconcileContainerQuadletShadow;
    static hasContainerQuadletUnit = hasContainerQuadletUnit;
    static decideContainerQuadletRecreate = decideContainerQuadletRecreate;
    static deployContainerQuadlet = deployContainerQuadlet;
    static prePullImages = prePullImages;

    // ── trash bucket (./lifecycle/trash) ──────────────────────────────────
    static deleteService = deleteService;
    static restoreTrashedService = restoreTrashedService;
    static purgeTrash = purgeTrash;

    // ── rename + image refresh (./lifecycle/rename, imageRefresh) ─────────
    static renameService = renameService;
    static updateAndRestartService = updateAndRestartService;
    static updateServiceDescription = updateServiceDescription;
}
