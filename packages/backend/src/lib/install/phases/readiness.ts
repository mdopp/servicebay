/**
 * Readiness gates for the install run (#2742 — split out of `runner.ts`).
 *
 * Two waits, one predicate, all reading the in-process digital twin:
 *   - `isServiceReady` — is this service up, by the best signal available?
 *   - `waitForDependencies` — block an item until its declared deps are up.
 *   - `settleWait` — block the run until everything it deployed is up.
 *
 * Both waits are best-effort by design: they cap, log what is still missing
 * and return, so a slow dependency degrades the run's reporting rather than
 * wedging the install forever.
 */
import { getStoreSnapshot } from '@/lib/store/repository';
import { isJobAborted, log } from './context';

/** Cross-template settle-wait: poll the digital twin until every newly
 *  deployed service reports active. Cap at 3 minutes — long enough for
 *  cold-start image pulls on a normal connection — then transition either
 *  way and let the diagnose probe report what's genuinely stuck. */
const SETTLE_TIMEOUT_MS = 3 * 60_000;
const SETTLE_POLL_MS = 5_000;
const SETTLE_HEARTBEAT_MS = 15_000;

/** Inter-template dependency-readiness gate (#810). The topo-sort
 *  guarantees a template deploys *after* its `servicebay.dependencies`,
 *  but ordering is not readiness — the deploy loop fires each template's
 *  post-deploy script back-to-back, so a script that talks to a
 *  dependency's API (e.g. `media` post-deploy → Authelia OIDC discovery)
 *  can run while that dependency is still booting. Before deploying an
 *  item we block until every declared dependency reports health-ready in
 *  the twin. Same 3-minute cap as the settle-wait — long enough for a
 *  cold-start image pull, then proceed and let diagnose surface a real
 *  failure rather than hanging the install forever. */
const DEP_READY_TIMEOUT_MS = 3 * 60_000;
const DEP_READY_POLL_MS = 3_000;

/** True when `name` reports ready in the twin's service list. Prefers
 *  the unified health signal (#627) — set by the service-health poller
 *  when the template ships a `servicebay.healthcheck` annotation — and
 *  falls back to the systemd-active flag for templates that don't ship
 *  one yet. `degraded: true` still counts as ready (the operator sees
 *  the soft-fail banner; gating doesn't hang on it). */
export function isServiceReady(
  services: ReadonlyArray<{ name: string; active?: boolean; health?: { ready: boolean } }>,
  name: string,
): boolean {
  return services.some(s => {
    if (s.name !== name && s.name !== `${name}.service`) return false;
    if (s.health) return s.health.ready === true;
    return s.active === true;
  });
}

/** Settle-wait: poll the digital twin in-process until every newly
 *  deployed service is ready.
 *
 *  Readiness preference order (#627):
 *    1. `twin.services[].health.ready === true` — set by the service-health
 *       poller (#626) when the template ships a `servicebay.healthcheck`
 *       annotation. This is the canonical signal Phase 3 migrates everyone
 *       onto.
 *    2. `twin.services[].active === true` — legacy systemd-state-only
 *       fallback for templates without a healthcheck annotation yet.
 *       Phase 3C removes this once every template has migrated.
 *
 *  Either signal counts. The browser version of this used to receive twin
 *  snapshots over Socket.IO; server-side we read the singleton directly,
 *  which is both simpler and authoritative. */
export async function settleWait(
  jobId: string,
  deployed: { name: string }[],
  node: string,
): Promise<void> {
  if (deployed.length === 0) return;
  const expected = deployed.map(i => i.name);
  const startedAt = Date.now();
  let lastReady = -1;
  let lastLogAt = Date.now();
  while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
    if (isJobAborted(jobId)) return;
    const snapshot = getStoreSnapshot();
    const twinNode = snapshot.nodes?.[node];
    const services = twinNode?.services ?? [];
    const ready = expected.filter(name => isServiceReady(services, name)).length;
    const now = Date.now();
    if (ready !== lastReady) {
      await log(jobId, `Waiting for services to become active... (${ready}/${expected.length} up)`);
      lastReady = ready;
      lastLogAt = now;
    } else if (now - lastLogAt >= SETTLE_HEARTBEAT_MS) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      await log(jobId, `Still waiting... (${ready}/${expected.length} up, ${elapsed}s elapsed)`);
      lastLogAt = now;
    }
    if (ready === expected.length) break;
    await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (lastReady === expected.length) {
    await log(jobId, `✅ All ${expected.length} services active after ${elapsed}s.`);
  } else {
    await log(jobId, `⚠️ ${lastReady}/${expected.length} services active after ${elapsed}s — slow image pulls or a real failure. Self-diagnose below will tell you which.`);
  }
}

/** Block until every declared dependency of `item` reports health-ready
 *  in the twin (#810). Called before the item deploys — its post-deploy
 *  script runs as part of the same `/api/services` POST, so the
 *  dependency must be responsive *before* the deploy fires, not just
 *  ordered ahead of it.
 *
 *  Best-effort by design: on timeout we log a warning and proceed. The
 *  post-deploy may then report errors, but those surface through the
 *  normal diagnose path — far better than wedging the whole install on
 *  one slow dependency. `bootstrapServiceHealth` is invoked first so the
 *  poller is already probing every just-deployed dependency; without
 *  that the gate would only ever see the coarse systemd-active flag. */
export async function waitForDependencies(
  jobId: string,
  item: { name: string; dependencies?: string[] },
  node: string,
): Promise<void> {
  const deps = item.dependencies ?? [];
  if (deps.length === 0) return;

  // Register every deployed-so-far service with the health poller so the
  // dependencies we're about to wait on have a live `health` signal.
  try {
    const { bootstrapServiceHealth } = await import('@/lib/health/serviceHealthBootstrap');
    await bootstrapServiceHealth(node);
  } catch { /* fall back to the systemd-active signal */ }

  const startedAt = Date.now();
  let lastLogAt = startedAt;
  const pending = new Set(deps);
  await log(jobId, `Waiting for ${item.name}'s dependencies to become healthy: ${deps.join(', ')}...`);
  while (pending.size > 0 && Date.now() - startedAt < DEP_READY_TIMEOUT_MS) {
    if (isJobAborted(jobId)) return;
    const services = getStoreSnapshot().nodes?.[node]?.services ?? [];
    for (const dep of [...pending]) {
      if (isServiceReady(services, dep)) pending.delete(dep);
    }
    if (pending.size === 0) break;
    const now = Date.now();
    if (now - lastLogAt >= SETTLE_HEARTBEAT_MS) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      await log(jobId, `Still waiting for ${[...pending].join(', ')} to be healthy (${elapsed}s elapsed)...`);
      lastLogAt = now;
    }
    await new Promise(r => setTimeout(r, DEP_READY_POLL_MS));
  }
  if (pending.size === 0) {
    await log(jobId, `✅ ${item.name}'s dependencies are healthy.`);
  } else {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    await log(jobId, `⚠️ ${item.name}'s dependencies not healthy after ${elapsed}s (${[...pending].join(', ')}). Continuing anyway — its post-deploy may report errors; self-diagnose below will tell you what's stuck.`);
  }
}
