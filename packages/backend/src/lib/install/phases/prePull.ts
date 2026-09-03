/**
 * Parallel image pre-pull (#2742 — split out of `runner.ts`). Part of the
 * pre-flight phase; `./preflight` calls this, the runner does not.
 *
 * Pulls are the long pole of a cold install (multi-GB layers over a 5 Mbps
 * line) and have no install-ordering dependency on each other, so warming
 * every referenced image in parallel cuts cold-install wall-clock roughly
 * linearly with the number of independent images.
 *
 * Best-effort: a failed pull does NOT abort the install. The subsequent unit
 * start triggers a sequential retry via Quadlet's own image-pull path; the
 * operator just loses the parallelism benefit for that one image.
 */
import { renderTemplate } from '@/lib/template/render';
import type { StackVariable } from '@/lib/stackInstall/postInstall';
import type { JobInput } from '../jobStore';
import { PullTracker, describePull } from '../pullProgress';
import { humanBytes, log } from './context';

/** Extract every unique container `image:` reference from items the
 *  install runner is about to deploy. Filters out already-installed
 *  items (their images are warm by definition) and items without yaml.
 *
 *  Uses a tolerant regex (the value after `image:` up to whitespace or
 *  `#`) rather than a YAML parse — templates carry Mustache placeholders
 *  in unrelated fields that can break js-yaml. Images themselves are
 *  static refs in every shipped template, so the regex is reliable here.
 */
export function collectImagesToPull(
  items: ReadonlyArray<{ name: string; yaml?: string; alreadyInstalled?: boolean }>,
  view?: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const imageRe = /^[\t ]*-?[\t ]*image:[\t ]*['"]?([^\s'"#]+)['"]?[\t ]*(?:#.*)?$/gm;
  for (const item of items) {
    if (item.alreadyInstalled || !item.yaml) continue;
    for (const m of item.yaml.matchAll(imageRe)) {
      let image = m[1].trim();
      if (!image) continue;
      // Templates may interpolate the image tag via Mustache
      // (e.g. `image: {{GATEKEEPER_IMAGE}}`). The pre-pull step ran
      // BEFORE per-item Mustache rendering, so the literal placeholder
      // hit `agent.pullImage()` and surfaced as
      //   "(note) pre-pull failed for {{GATEKEEPER_IMAGE}}: parsing
      //   reference … invalid reference format"
      // in the install log. Render now when a view is provided. If
      // the rendered string STILL contains an unresolved `{{...}}`
      // (no value for that variable), skip the pre-pull for that
      // image — the deploy-step's sequential pull will handle it
      // with the proper render context. #1170.
      if (view) {
        image = renderTemplate(image, view);
        // Mustache expands missing vars to '' rather than leaving the
        // literal `{{...}}` in place, so check both shapes — empty or
        // still-templated → skip and let the deploy step handle it.
        if (!image || image.includes('{{')) continue;
      }
      seen.add(image);
    }
  }
  return [...seen];
}

/** Per-image progress (#805). The agent emits PULL_PROGRESS per layer
 *  (docker-compat stream: status + byte progress + "Already exists" for
 *  cached layers). A PullTracker aggregates layers into one coalesced
 *  line every ~2s — bytes + percent once known, otherwise a "preparing"
 *  heartbeat — so a large pull never looks hung and the operator sees how
 *  many layers were already on the box. */
function pullProgressReporter(
  jobId: string,
  trackers: Map<string, PullTracker>,
): (image: string) => (ev: { id?: string; status?: string; current?: number; total?: number }) => void {
  const lastEmit = new Map<string, number>();
  return (image: string) => (ev) => {
    let tracker = trackers.get(image);
    if (!tracker) { tracker = new PullTracker(); trackers.set(image, tracker); }
    tracker.update(ev);
    const now = Date.now();
    if (now - (lastEmit.get(image) ?? 0) < 2000) return;
    lastEmit.set(image, now);
    const line = describePull(image, tracker.summary(), humanBytes);
    if (line) void log(jobId, `  ${line}`);
  };
}

/**
 * Warm every container image the selected items reference, in parallel.
 *
 * Render image refs against the wizard variables so templates that
 * interpolate `image: {{VAR}}` get a real registry reference at pre-pull
 * time, not the literal placeholder (#1170).
 */
export async function runPrePullPhase(
  jobId: string,
  input: JobInput,
  selected: ReadonlyArray<{ name: string; yaml?: string; alreadyInstalled?: boolean }>,
): Promise<void> {
  const prePullView = (input.variables as StackVariable[]).reduce<Record<string, string>>((acc, v) => {
    if (typeof v.value === 'string') acc[v.name] = v.value;
    return acc;
  }, {});
  const imagesToPull = collectImagesToPull(selected, prePullView);
  if (imagesToPull.length === 0) return;

  await log(jobId, `📦 Pre-pulling ${imagesToPull.length} container image${imagesToPull.length === 1 ? '' : 's'} in parallel...`);
  const node = input.node || 'Local';
  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(node);
    const trackers = new Map<string, PullTracker>();
    const onProgress = pullProgressReporter(jobId, trackers);
    const results = await Promise.allSettled(
      imagesToPull.map(image => agent.pullImage(image, onProgress(image))),
    );
    let okCount = 0;
    const failures: { image: string; reason: string }[] = [];
    results.forEach((r, i) => {
      const image = imagesToPull[i];
      if (r.status === 'fulfilled' && r.value?.success) {
        okCount++;
      } else {
        const reason = r.status === 'rejected'
          ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
          : 'agent reported failure';
        failures.push({ image, reason });
      }
    });
    await log(jobId, `✅ Pulled ${okCount}/${imagesToPull.length} image${imagesToPull.length === 1 ? '' : 's'}.`);
    for (const f of failures) {
      const s = trackers.get(f.image)?.summary();
      const got = s && s.bytesTotal > 0
        ? ` (reached ${humanBytes(s.bytesCurrent)}/${humanBytes(s.bytesTotal)}${s.cached ? `, ${s.cached} cached` : ''})`
        : '';
      await log(jobId, `(note) pre-pull failed for ${f.image}: ${f.reason}${got} — will be retried during deploy.`);
    }
  } catch (e) {
    await log(jobId, `(note) parallel pre-pull skipped: ${e instanceof Error ? e.message : String(e)} — deploy will pull sequentially as usual.`);
  }
}
