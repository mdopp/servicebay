/**
 * "Deployment done" with a checkable meaning (#3021).
 *
 * `release-check.mjs` answers the repo half — *does this repo have a working
 * path from code to a published image?* This is the box half — *does what I
 * just rolled out actually run?*
 *
 * The six points come from `checklist-a-deployment-is-not-done-until-you-looked`
 * (#3019). They existed as prose, and prose only works when somebody opens it —
 * which a session does least at the moment it believes it is finished. The same
 * health-probe fault happened twice in two days, the second time with that very
 * checklist already in the catalog. So the checklist becomes a measurement, and
 * the question changes from "did you verify?" to "what does `servicebay verify`
 * say?"
 *
 * ## Four verdicts, not two
 *
 * `ok` and `problem` are not enough, and collapsing the other two into either
 * is how a verification tool starts lying:
 *
 *   - `unknown` — we could not measure it. NOT a pass (that would be the
 *     `ownershipSet: true` shape all over again) and NOT a failure (blocking on
 *     our own blindness is the #3020 lesson).
 *   - `skipped` — there is nothing to measure. A service with no proxy route
 *     has no broken proxy route.
 *
 * Only `problem` makes the exit code non-zero. `unknown` is reported and
 * counted, because a report that hides what it could not see is worth less than
 * no report.
 *
 * ## What is deliberately NOT here
 *
 * The browser check — does the page load without console errors. It needs a
 * browser the box does not have, and it belongs in the session that has one.
 * The checklist says how; a verb that pretended to cover it would make
 * "verify says ok" mean less than it does.
 */
import { inspectManifestShape } from './deployPreflight';
import { psLineIndicatesLoop } from '@/lib/diagnose/runDiagnose';

type VerifyStatus = 'ok' | 'problem' | 'unknown' | 'skipped';

export interface VerifyCheck {
  id: 'health' | 'restarts' | 'image' | 'manifest' | 'proxy-route' | 'public-url';
  /** One line naming what is being checked, for the rendered output. */
  title: string;
  status: VerifyStatus;
  /** The value actually read. Present even when `ok` — a verification that
   *  shows no measurement is an assertion. */
  measured: string;
  /** Only when `problem` or `unknown`: what it means and what to do. */
  detail?: string;
}

export interface VerifyReport {
  service: string;
  node: string;
  checks: VerifyCheck[];
  /** No `problem` among the checks. `unknown` does not make it false — it makes
   *  `complete` false. */
  ok: boolean;
  /** Every check returned a real measurement. */
  complete: boolean;
  summary: string;
}

/** One container's state as podman reports it, reduced to what we read. */
export interface ContainerState {
  name: string;
  status: string;
  restartCount: number;
  /** ISO start time. Without it a freshly-restarting container reads as
   *  long-stable and the restart rule never fires — the exact case this check
   *  exists for. */
  startedAt?: string;
  health?: { status?: string; failingStreak?: number; lastOutput?: string };
}

/* ── the individual checks, each a pure function over what was measured ────── */

export function checkHealth(containers: ContainerState[]): VerifyCheck {
  const base = { id: 'health' as const, title: 'container health check is green' };
  const withHealth = containers.filter(c => c.health?.status);
  if (containers.length === 0) {
    return { ...base, status: 'unknown', measured: 'no containers found', detail: 'The service reports no containers — it may not have started at all. `servicebay logs <service>` says why.' };
  }
  if (withHealth.length === 0) {
    return { ...base, status: 'skipped', measured: 'no container declares a health check' };
  }
  const unhealthy = withHealth.filter(c => c.health!.status !== 'healthy');
  const measured = withHealth.map(c => `${c.name}=${c.health!.status}${c.health?.failingStreak ? ` (failing ${c.health.failingStreak}×)` : ''}`).join(', ');
  if (unhealthy.length === 0) return { ...base, status: 'ok', measured };

  // The last health-log line is the part that says WHY, and it is the part a
  // status word alone never carries.
  const why = unhealthy.map(c => c.health?.lastOutput).filter(Boolean).join(' | ').slice(0, 400);
  const starting = unhealthy.every(c => c.health!.status === 'starting');
  return {
    ...base,
    status: starting ? 'unknown' : 'problem',
    measured,
    detail: starting
      ? 'The check is still in its start period. Measure again in a minute rather than calling it done.'
      : `The health check is failing${why ? `: ${why}` : ''}. A check that can NEVER pass — a binary the image does not `
        + 'have, a port nothing listens on — restarts the container forever; that is what #3020 refuses at deploy time, '
        + 'but an existing service can still be in it.',
  };
}

export function checkRestarts(containers: ContainerState[]): VerifyCheck {
  const base = { id: 'restarts' as const, title: 'container is not restarting' };
  if (containers.length === 0) return { ...base, status: 'unknown', measured: 'no containers found' };
  const measured = containers.map(c => `${c.name}: ${c.restartCount} restart(s), ${c.status}`).join('; ');
  // Reuse the diagnose kernel's rule rather than re-deriving it: a high
  // LIFETIME count on a container that has since been up for hours is history,
  // not a loop (the solaris-tts-bridge false positive).
  const looping = containers.filter(c => psLineIndicatesLoop(c.status, c.restartCount, { treatYoungAsLoop: true, threshold: 5 }));
  if (looping.length === 0) return { ...base, status: 'ok', measured };
  return {
    ...base,
    status: 'problem',
    measured,
    detail: `${looping.map(c => c.name).join(', ')} is restarting. A restart loop is usually a health check the container `
      + 'cannot pass or a process that exits immediately; `servicebay logs <service>` carries the exit reason. One such '
      + 'loop reached 1006 restarts and made the whole box slow before anyone connected the two.',
  };
}

export function checkImage(imageReport: { ok?: boolean; summary?: string; images?: { image: string; published?: boolean; upToDate?: boolean | null; problem?: string | null }[] } | null): VerifyCheck {
  const base = { id: 'image' as const, title: 'running the image the registry publishes' };
  if (!imageReport) return { ...base, status: 'unknown', measured: 'could not read the image status' };
  const images = imageReport.images ?? [];
  if (images.length === 0) return { ...base, status: 'skipped', measured: 'the service declares no image reference' };
  const verdict = (i: { published?: boolean; upToDate?: boolean | null; problem?: string | null }) => {
    if (i.published) return i.upToDate === false ? 'behind' : i.upToDate === null ? 'published, local unknown' : 'current';
    return i.problem === 'not-published' ? 'NOT PUBLISHED' : `could not check (${i.problem ?? 'unknown'})`;
  };
  const measured = images.map(i => `${i.image}: ${verdict(i)}`).join('; ');
  // Only a registry that ANSWERED and has no such tag is a problem. One we
  // could not reach, or whose manifest we could not read, is unknown — calling
  // that a problem sends someone to fix a build that is fine (#3036).
  const unpublished = images.filter(i => i.published === false && i.problem === 'not-published');
  if (unpublished.length > 0) return { ...base, status: 'problem', measured, detail: imageReport.summary };
  const unreadable = images.filter(i => i.published === false);
  if (unreadable.length > 0) return { ...base, status: 'unknown', measured, detail: imageReport.summary };
  if (images.some(i => i.upToDate === false)) {
    return { ...base, status: 'problem', measured, detail: `The registry serves a newer image than the one running. \`servicebay update <service>\` moves it.` };
  }
  if (images.some(i => i.upToDate === null)) return { ...base, status: 'unknown', measured, detail: 'One digest could not be read, so "current" cannot be claimed.' };
  return { ...base, status: 'ok', measured };
}

export function checkManifest(yamlContent: string | null): VerifyCheck {
  const base = { id: 'manifest' as const, title: 'the application is in the image, not in the pod spec' };
  if (!yamlContent) return { ...base, status: 'skipped', measured: 'no pod spec (a .container unit declares its image directly)' };
  const findings = inspectManifestShape(yamlContent);
  const kb = Math.round(Buffer.byteLength(yamlContent, 'utf8') / 1024);
  if (findings.length === 0) return { ...base, status: 'ok', measured: `${kb} KB, no embedded blob` };
  return { ...base, status: 'problem', measured: `${kb} KB`, detail: findings.map(f => f.message).join(' ') };
}

export function checkProxyRoute(
  service: string,
  routes: { host: string; targetService: string; targetPort: number }[],
  knownServices: string[],
): VerifyCheck {
  const base = { id: 'proxy-route' as const, title: 'the proxy route names a service that exists' };
  const mine = routes.filter(r => r.targetService === service);
  if (mine.length === 0) return { ...base, status: 'skipped', measured: 'no proxy route points at this service' };
  const measured = mine.map(r => `${r.host} → ${r.targetService}:${r.targetPort}`).join('; ');
  // The service we were asked about exists by construction, so what this really
  // catches is a route left behind pointing at a name nobody serves — the third
  // fault in #3020, which "worked" only because another service happened to
  // hold the same port.
  const dangling = routes.filter(r => !knownServices.includes(r.targetService));
  if (dangling.length === 0) return { ...base, status: 'ok', measured };
  return {
    ...base,
    status: 'problem',
    measured: `${measured} — but ${dangling.map(r => `${r.host} → ${r.targetService}`).join(', ')} names no installed service`,
    detail: 'A route pointing at a deleted service may still appear to work, because another service happens to hold '
      + "that port. ServiceBay's own bookkeeping is then wrong, and the next port change breaks it silently.",
  };
}

export function checkPublicUrl(result: { url: string; status?: number; error?: string } | null): VerifyCheck {
  const base = { id: 'public-url' as const, title: 'the public URL answers' };
  if (!result) return { ...base, status: 'skipped', measured: 'the service has no public host' };
  if (result.error) {
    return { ...base, status: 'problem', measured: `${result.url}: ${result.error}`, detail: 'Reached from the BOX, not from inside a pod — a pod cannot reach the box\'s public name (ADR 0007). A DNS or proxy fault shows here before a user finds it.' };
  }
  const code = result.status ?? 0;
  const measured = `${result.url} → HTTP ${code}`;
  // A 401/403 is the SSO gate answering, which is a working route.
  if (code >= 200 && code < 400) return { ...base, status: 'ok', measured };
  if (code === 401 || code === 403) return { ...base, status: 'ok', measured: `${measured} (the SSO gate answered — the route works)` };
  return { ...base, status: 'problem', measured, detail: 'The route resolves but the service behind it did not answer with a usable status.' };
}

/* ── the report ───────────────────────────────────────────────────────────── */

export function buildReport(service: string, node: string, checks: VerifyCheck[]): VerifyReport {
  const problems = checks.filter(c => c.status === 'problem');
  const unknowns = checks.filter(c => c.status === 'unknown');
  const ok = problems.length === 0;
  const complete = unknowns.length === 0;

  let summary: string;
  if (problems.length > 0) {
    summary = `${service} is NOT done: ${problems.map(p => p.title).join('; ')}. Read the detail on each — every line names the next step.`;
  } else if (unknowns.length > 0) {
    summary = `${service} shows no problem, but ${unknowns.length} check could not be measured (${unknowns.map(u => u.id).join(', ')}). `
      + 'That is not the same as passing — say which, rather than reporting it as done.';
  } else {
    summary = `${service}: every measurable check passed. The one thing this cannot see is whether the page renders `
      + 'without console errors — that needs a browser, and it belongs in the session that has one.';
  }
  return { service, node, checks, ok, complete, summary };
}
