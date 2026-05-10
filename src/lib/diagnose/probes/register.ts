/**
 * Side-effect-only module: imports every per-probe registration so the
 * probe-action registry is populated at module load. Routes that
 * dispatch user-clicked actions (`api/system/diagnose/run-action`) and
 * routes that surface the action list (`api/system/diagnose`) both
 * import this file once.
 *
 * Per-probe modules live alongside this one — each calls
 * `registerProbeAction(probeId, action, handler)` at the top level.
 *
 * Sections B6–B15 of the "Self-healing UX rollout" tracking issue add
 * their probes here.
 */

import './npmDataStale';
import './routerDnsNotPointing';
import './danglingProxy';
import './postDeployFailed';
import './crashLoop';
import './proxyRouteMissing';
import './failedUnits';
import './healthChecks';

export {};
