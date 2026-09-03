/**
 * Server-side install runner.
 *
 * Owns the deploy loop that used to live in `useStackInstall.runInstall`
 * (browser). Moving it server-side fixes the long-standing failure mode
 * where closing the browser tab during install left the wizard stuck:
 * the in-flight `/api/services?stream=1` request would complete on the
 * server but the *next* template in the loop was never started, because
 * the loop itself ran in the browser.
 *
 * Lifecycle:
 *
 *   /api/install/start  → createJob() + startJob() (this file)
 *                              ↓
 *                       runs detached, persists progress to jobStore,
 *                       emits live updates via socketBridge
 *                              ↓
 *   client subscribes via socket events; reattaches via
 *   GET /api/install/status when a tab opens mid-flow.
 *
 * ## What lives here, and what does not (#2742)
 *
 * This file is the **facade + the order of the phases + the job status**.
 * Nothing else. Each phase is a module under `./phases/`, exposing one
 * `run…Phase(ctx)` entry point:
 *
 *   phases/preflight.ts      LAN IP, orphan records, registry + spec refresh,
 *                            topo-sort, secret reuse, state self-heals, pre-pull
 *   phases/migrations.ts     the schema-migration chain for one upgraded item
 *   phases/assetTransport.ts pod render, missing-var + sentinel guards, files, env
 *   phases/kubePlay.ts       deploy ONE item via /api/services?stream=1
 *   phases/postDeploy.ts     health, NPM, capability events, portal, settle-wait
 *   phases/finalize.ts       the writes only a finished run may make
 *   phases/selfTest.ts       the post-install SSO end-to-end verification
 *
 * `phases/context.ts` holds the plumbing they share: the job log, the job
 * patch, and the per-job abort flag. Cross-cutting state (abort flags,
 * NPM-credentials pause promises) does not survive a server restart by
 * design: any job in an active phase at startup is flipped to `crashed` by
 * `jobStore.markCrashedOnStartup()` (see server.ts).
 *
 * Re-exports below keep the install route handlers, the MCP tools and the
 * unit tests on `@/lib/install/runner` — the split is structural, not an
 * API change (same contract as the #975 extractions).
 */
import { getJob } from './jobStore';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';
import { clearPendingCredentials, provideCredentials, skipCredentials } from './credentialResolver';
import { ensureProxyHosts } from './postInstallDispatcher';
import {
  clearJobAbortFlag,
  isJobAborted,
  log,
  markJobAborted,
  patchJob,
  type DeployContext,
} from './phases/context';
import { runPreflightPhase } from './phases/preflight';
// The kube-play phase, imported under its historical call-site name: the
// deploy loop below reads as "deploy this item", and the #2601 source-shape
// guard in runner.test.ts is pinned to that exact call.
import { runKubePlayPhase as deployItem } from './phases/kubePlay';
import { runPostDeployPhase } from './phases/postDeploy';
import { runFinalizePhase } from './phases/finalize';
import { runSelfTestPhase } from './phases/selfTest';
import { waitForDependencies } from './phases/readiness';

// Re-export the surface previously exposed from this module so the
// install route handlers + tests don't have to learn the new file
// names. The extractions in #975 and #2742 are structural, not API changes.
export { provideCredentials, skipCredentials, ensureProxyHosts };
export { collectImagesToPull } from './phases/prePull';
export { isServiceReady, waitForDependencies } from './phases/readiness';
export {
  authDynamicVars,
  buildRenderedSentinelError,
  findEmptyYamlVars,
  findSentinelSecretsInYaml,
  loadPostDeployScript,
  preserveAutheliaOidcClients,
} from './phases/assetTransport';
export { buildMigrationSteps } from './phases/migrations';
export {
  buildSentinelUnresolvedError,
  formatSecretNameList,
  formatSecretRotationLog,
  formatSentinelRestoredLog,
  reuseSavedSecrets,
} from './phases/secretReuse';

/** Public abort entry-point. Sets the in-memory flag and unblocks any
 *  pending credential prompt. The deploy loop discovers the flag on
 *  the next iteration and exits cleanly. */
export function abortJob(jobId: string): void {
  markJobAborted(jobId);
  clearPendingCredentials(jobId);
}

/**
 * One line stating what a run that did not deploy everything it was asked to
 * actually left behind (#2601).
 *
 * This exists because "success reported, nothing done" is the failure mode
 * that hurts here: the pre-fix runner could end a run having rolled out
 * nothing at all and still hand the dialog its finished-run buttons. The
 * denominator — how many of the requested services reached the box — is the
 * thing to state, not the return status.
 */
export function summariseIncompleteRun(
  deployed: ReadonlyArray<string>,
  requested: ReadonlyArray<string>,
): string {
  const missing = requested.filter(n => !deployed.includes(n));
  if (missing.length === 0) return `✅ ${deployed.length}/${requested.length} requested service(s) deployed.`;
  if (deployed.length === 0) {
    return `❌ Nothing was deployed: 0 of ${requested.length} requested service(s) reached the box (${missing.join(', ')}).`;
  }
  return `❌ ${deployed.length}/${requested.length} requested service(s) deployed (${deployed.join(', ')}). NOT deployed: ${missing.join(', ')}.`;
}

/** The job patch every abort path writes. */
async function markAborted(jobId: string, error?: string): Promise<void> {
  await patchJob(jobId, {
    phase: 'aborted',
    endedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
}

/** Inner async pipeline — wrapped by `startJob` so the public surface
 *  can stay synchronous (kicks off the work, returns immediately). */
async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const input = job.input;

  // Reset abort flag for this run.
  clearJobAbortFlag(jobId);

  const scriptCredentials: Credential[] = [];
  const reusedSecretNames = new Set<string>();
  const ctx: DeployContext = { jobId, input, scriptCredentials, deployed: [], reusedSecretNames };

  // #1585 — the install runner NEVER system-wide-wipes. System-wide wipe
  // lives only in the explicit Factory Reset (`/api/system/factory-reset`).
  // Per-service wipe under the `wipeMode` model happens per-service in the
  // kube-play phase (it clears only that service's CONFIG (wipe-config) or
  // CONFIG+DATA (wipe-all) paths, never other services' data), then restores
  // CONFIG from the NAS on startup.

  const preflight = await runPreflightPhase(ctx);
  if (!preflight.ok) {
    if (preflight.kind === 'nothing-selected') {
      await patchJob(jobId, { phase: 'done', endedAt: new Date().toISOString(), credentialsManifest: [] });
    } else {
      await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: preflight.message });
    }
    return;
  }
  const selected = preflight.selected;

  // Deploy loop.
  //
  // #2601 — track what this run actually rolled out, separately from
  // `ctx.deployed` (which also carries the already-installed dependency
  // satisfiers it skipped). `toDeploy` is the set the operator asked for;
  // `deployedNew` is what reached the box. A run that ends with the two
  // unequal is NOT a success, and must not be reported as one.
  const toDeploy = selected.filter(s => !s.alreadyInstalled).map(s => s.name);
  const deployedNew: string[] = [];
  for (const item of selected) {
    if (isJobAborted(jobId)) {
      await markAborted(jobId, 'Installation aborted by user.');
      await log(jobId, '⛔ Install aborted by user.');
      return;
    }
    if (item.alreadyInstalled) {
      await log(jobId, `✅ ${item.name} already installed, skipping.`);
      ctx.deployed.push({ name: item.name });
      continue;
    }
    // #810 — gate on dependency readiness before deploying. The item's
    // post-deploy script runs inside the kube-play phase, so a dependency
    // that is merely ordered ahead (not yet healthy) would otherwise be hit
    // mid-boot.
    await waitForDependencies(jobId, item, input.node || 'Local');
    if (isJobAborted(jobId)) {
      await markAborted(jobId, 'Installation aborted by user.');
      await log(jobId, '⛔ Install aborted by user.');
      return;
    }
    try {
      const ok = await deployItem(ctx, item);
      if (ok) {
        ctx.deployed.push({ name: item.name });
        deployedNew.push(item.name);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // #2601 — the throw path used to set `phase: 'error'` and return without
      // writing a single line to the job log. The dialog's last visible line
      // was therefore whatever succeeded just before (typically the green
      // "dependencies are healthy"), under the buttons of a finished run.
      // State the stop explicitly, and say what it cost.
      await log(jobId, `❌ Install stopped at ${item.name}: ${msg}`);
      await log(jobId, summariseIncompleteRun(deployedNew, toDeploy));
      await patchJob(jobId, {
        phase: 'error',
        endedAt: new Date().toISOString(),
        error: msg,
        progress: {
          currentItem: null,
          deployedNames: ctx.deployed.map(d => d.name),
          totalCount: input.items.filter(i => i.checked).length,
        },
      });
      return;
    }
  }

  const postDeploy = await runPostDeployPhase(ctx);
  if (postDeploy.aborted) {
    await markAborted(jobId);
    return;
  }

  // #2601 — the terminal verdict follows what actually reached the box, not
  // the fact that the loop ran to the end. The kube-play phase can return
  // false (fatal 4xx, retries exhausted, no spec in the manifest) for every
  // single item and the run would still have landed here as `done`, which is
  // what made a no-op upgrade indistinguishable from a real one. The
  // post-install work above still runs either way — only the verdict changes.
  const runSummary = summariseIncompleteRun(deployedNew, toDeploy);
  const incomplete = deployedNew.length < toDeploy.length;
  if (incomplete) await log(jobId, runSummary);
  await patchJob(jobId, {
    phase: incomplete ? 'error' : 'done',
    endedAt: new Date().toISOString(),
    ...(incomplete ? { error: runSummary.replace(/^❌ /, '') } : {}),
    progress: {
      currentItem: null,
      deployedNames: ctx.deployed.map(d => d.name),
      totalCount: input.items.filter(i => i.checked).length,
    },
  });

  await runFinalizePhase(ctx);

  // Fire the end-to-end SSO verification (#1454, consumes #1453). Detached +
  // fully best-effort — see runSelfTestPhase.
  void runSelfTestPhase(jobId, input.node);
}

/** Public entry-point. Fires off `runJob` as a detached task — caller
 *  returns immediately. Errors are caught and recorded on the job; they
 *  never propagate up because there's no caller waiting for them. */
export function startJob(jobId: string): void {
  void (async () => {
    try {
      await runJob(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // #2601 — log before patching. A runner that only sets `error` on the
      // job state leaves the operator staring at whatever line succeeded last,
      // under the buttons of a finished run.
      await log(jobId, `❌ Internal runner error: ${msg}`);
      await patchJob(jobId, {
        phase: 'error',
        endedAt: new Date().toISOString(),
        error: `Internal runner error: ${msg}`,
      });
    } finally {
      clearJobAbortFlag(jobId);
      clearPendingCredentials(jobId);
    }
  })();
}
