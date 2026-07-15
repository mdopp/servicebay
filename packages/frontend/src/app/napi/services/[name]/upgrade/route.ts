import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { getPendingTemplateUpgrades } from '@/lib/templateUpgrades';
import { getInstalledImageUpdates } from '@/lib/imageDigest';
import { assembleManifest, applyVariableDefaults } from '@/lib/install/manifestAssembler';
import {
  createJob,
  getCurrentJob,
  InstallInProgressError,
  type JobInput,
} from '@/lib/install/jobStore';
import { startJob } from '@/lib/install/runner';

export const dynamic = 'force-dynamic';

/**
 * POST /napi/services/:name/upgrade — apply a pending service upgrade from the
 * companion app (#2313, consumer Solaris solarisbay#827).
 *
 * The token-only, proxy-bypassed mutating twin of the two browser upgrade-apply
 * paths. The read side (`GET /napi/upgrades`, #2252) already tells the app that
 * an upgrade is available for `<name>` in one of two kinds; this route APPLIES
 * it, reusing the SAME primitives the browser uses — no second upgrade code
 * path (mirrors how the operate route reuses ServiceManager):
 *   - `image`    → `ServiceManager.updateAndRestartService(node, name)` — the
 *                  exact primitive `POST /api/services/[name]/action`'s
 *                  `update` action calls (pull newer image from the on-disk
 *                  YAML, reload daemon, restart the unit).
 *   - `template` → the wizard's server-side deploy flow
 *                  `assembleManifest → applyVariableDefaults → createJob →
 *                  startJob` for this ONE service (the same lib functions
 *                  `POST /api/install/assemble` + `/api/install/start` and the
 *                  `install_template` MCP tool #2141 drive) — the full template
 *                  re-deploy (variable assembly, secret gen, proxy/Authelia
 *                  wiring, dependency ordering, migrations), not a raw redeploy.
 *
 * TOKEN-GATED, `mutate`-scoped. An upgrade re-deploys the service — a spec/image
 * mutation, heavier than operate's reversible start/stop/restart — so it sits at
 * the `mutate` tier (create/update/add + config writes, per apiScope.ts; the
 * same tier `install_template`/`deploy_service` carry). `tokenScope: 'mutate'`
 * in the withApiHandlerParams OPTIONS (#2249 — the scope lives where the gate
 * actually reads it, NOT an inner requireSession that would 401 a valid Bearer).
 * A `read`-only device token (the pairing default, #2251) OR a `lifecycle` token
 * (which can operate but not re-deploy) is REJECTED here.
 *
 * Body: optional `{ kind?: 'template' | 'image' }`. Omitted → apply whatever is
 * pending for the service (image first — the cheaper in-place pull — else
 * template). An explicit kind with nothing pending returns a clean no-op 200,
 * never a crash (memory feedback_dont_mask_failures: honest, not a false green).
 */
const Body = z.object({
  kind: z.enum(['template', 'image']).optional(),
});
const Query = z.object({ node: z.string().optional() });
type BodyT = z.infer<typeof Body>;
type QueryT = z.infer<typeof Query>;

async function applyImageUpgrade(nodeName: string, name: string) {
  const result = await ServiceManager.updateAndRestartService(nodeName, name);
  return NextResponse.json({ ok: true, name, kind: 'image' as const, ...result });
}

/**
 * Re-deploy the single service to its latest resolved template — the wizard
 * flow, one item. Fire-and-forget (returns a jobId to poll), matching the
 * browser install path. 409 if a deploy job is already running (single global
 * install lock — the app should let the running job finish).
 */
async function applyTemplateUpgrade(nodeName: string, name: string) {
  const active = await getCurrentJob();
  if (active) {
    return NextResponse.json(
      { ok: false, error: 'install already in progress', jobId: active.id },
      { status: 409 },
    );
  }
  try {
    const assembled = await assembleManifest({ items: [{ name, checked: true }] });
    const input: JobInput = {
      items: assembled.items,
      variables: assembled.variables,
      templateSource: 'Built-in',
      host: 'localhost',
      wipeMode: 'install',
      ...(nodeName ? { node: nodeName } : {}),
    };
    const withDefaults = await applyVariableDefaults(input);
    const job = await createJob({ source: 'napi', input: withDefaults });
    startJob(job.id);
    return NextResponse.json({ ok: true, name, kind: 'template' as const, jobId: job.id });
  } catch (e) {
    if (e instanceof InstallInProgressError) {
      return NextResponse.json(
        { ok: false, error: 'install already in progress', jobId: e.existingJobId },
        { status: 409 },
      );
    }
    throw e;
  }
}

export const POST = withApiHandlerParams<BodyT, QueryT, { name: string }>(
  { tokenScope: 'mutate', body: Body, query: Query },
  async ({ body, query, params }) => {
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ ok: false, error: 'invalid service name' }, { status: 400 });
    }
    const name = check.data;
    const nodeName = query.node || 'Local';

    try {
      // Which upgrade kinds are actually pending for THIS service? Drives the
      // default (no `kind`) selection and lets an explicit-kind request no-op
      // cleanly when nothing of that kind is waiting.
      const [templateUpgrades, imageUpdates] = await Promise.all([
        getPendingTemplateUpgrades(),
        getInstalledImageUpdates(),
      ]);
      const templatePending = templateUpgrades.some(t => t.name === name);
      const imagePending = imageUpdates.some(u => u.service === name && u.updateAvailable);

      if (body.kind === 'image') {
        if (!imagePending) {
          return NextResponse.json({ ok: true, name, kind: 'image', applied: false, reason: 'no image update pending' });
        }
        return await applyImageUpgrade(nodeName, name);
      }

      if (body.kind === 'template') {
        if (!templatePending) {
          return NextResponse.json({ ok: true, name, kind: 'template', applied: false, reason: 'no template upgrade pending' });
        }
        return await applyTemplateUpgrade(nodeName, name);
      }

      // Default: apply whatever is pending. Image first (cheap in-place pull),
      // else the template re-deploy job.
      if (imagePending) return await applyImageUpgrade(nodeName, name);
      if (templatePending) return await applyTemplateUpgrade(nodeName, name);

      return NextResponse.json({ ok: true, name, applied: false, reason: 'no upgrade pending' });
    } catch (e) {
      return apiError(e, { tag: 'napi:services:upgrade', status: 500 });
    }
  },
);
