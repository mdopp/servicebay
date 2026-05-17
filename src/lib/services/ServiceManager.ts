/**
 * ServiceManager — public-API facade (#589).
 *
 * The implementation used to live here as a 2,000-line class. Per the
 * reviewer's plan in the #589 thread, the methods now live in two
 * focused modules:
 *
 *   - `serviceListing.ts`   — read paths (list / get* / find /
 *                              listTrashed / getServiceStatus).
 *   - `serviceLifecycle.ts` — write paths (deploy / start / stop /
 *                              restart / delete / save / rename /
 *                              restore / purge / update*) plus the
 *                              entangled private helpers
 *                              (migratePredecessors, runPostDeployScript,
 *                              runMigrationScript, runPreStartHooks,
 *                              fixVolumeOwnership, backupQuadlets,
 *                              refreshAgent, prePullImages,
 *                              ensurePodmanSocket,
 *                              ensureUnprivilegedPorts).
 *
 * This file is the back-compat facade: every static method on
 * `ServiceManager` re-aliases the equivalent on `ServiceListing` /
 * `ServiceLifecycle`. The 88+ external call sites
 * (`ServiceManager.foo(...)`) continue to work unchanged.
 *
 * No logic lives here. Add behaviour in the right split file. Add
 * an alias here only when a new public method is introduced.
 */

import { ServiceListing } from './serviceListing';
import { ServiceLifecycle } from './serviceLifecycle';

// ServiceInfo + ServiceListing + ServiceLifecycle are not re-exported
// — consumers go through the ServiceManager facade. Anyone needing
// direct access to the split modules imports them from their own
// files (./serviceListing, ./serviceLifecycle).

export class ServiceManager {
    // ── read path (ServiceListing) ────────────────────────────────────────
    static listServices = ServiceListing.listServices;
    static getServiceFiles = ServiceListing.getServiceFiles;
    static getServiceLogs = ServiceListing.getServiceLogs;
    static getPodmanLogs = ServiceListing.getPodmanLogs;
    static listTrashedServices = ServiceListing.listTrashedServices;
    static findHostPortCollisions = ServiceListing.findHostPortCollisions;
    static extractHostPorts = ServiceListing.extractHostPorts;
    static getServiceStatus = ServiceListing.getServiceStatus;

    // ── write path (ServiceLifecycle) ─────────────────────────────────────
    static readonly STACK_MIGRATIONS = ServiceLifecycle.STACK_MIGRATIONS;
    static startService = ServiceLifecycle.startService;
    static stopService = ServiceLifecycle.stopService;
    static restartService = ServiceLifecycle.restartService;
    static reloadDaemon = ServiceLifecycle.reloadDaemon;
    static writeFile = ServiceLifecycle.writeFile;
    static ensurePodmanSocket = ServiceLifecycle.ensurePodmanSocket;
    static ensureUnprivilegedPorts = ServiceLifecycle.ensureUnprivilegedPorts;
    static deployKubeService = ServiceLifecycle.deployKubeService;
    static deployService = ServiceLifecycle.deployService;
    static removeService = ServiceLifecycle.removeService;
    static saveService = ServiceLifecycle.saveService;
    static deleteService = ServiceLifecycle.deleteService;
    static restoreTrashedService = ServiceLifecycle.restoreTrashedService;
    static purgeTrash = ServiceLifecycle.purgeTrash;
    static renameService = ServiceLifecycle.renameService;
    static updateAndRestartService = ServiceLifecycle.updateAndRestartService;
    static updateServiceDescription = ServiceLifecycle.updateServiceDescription;
    static prePullImages = ServiceLifecycle.prePullImages;
}
