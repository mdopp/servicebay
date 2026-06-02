import { NextResponse } from 'next/server';
import { createJob, getCurrentJob, InstallInProgressError, type JobInput } from '@/lib/install/jobStore';
import { applyVariableDefaults } from '@/lib/install/manifestAssembler';
import { startJob } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

/**
 * Kick off a server-side install job. Body shape mirrors the
 * `useStackInstall.runInstall` arguments — items + variables already
 * resolved client-side in the configure step. Server takes ownership
 * of the deploy loop from here.
 *
 * Idempotency: refuses to start a second job if one is already in an
 * active phase (running / needs_credentials). The wizard surfaces this
 * via the `installInProgress` banner + reattach flow.
 *
 * Two layers of serialization: the pre-check below is a fast path for
 * the common case (already-running install observed via the
 * `installInProgress` banner). The authoritative gate is inside
 * `createJob` (#1100), which holds an in-process lock across the
 * active-job re-check and the state-file write — without that lock,
 * two parallel POSTs could both pass this pre-check and start
 * simultaneous installs racing on shared host state.
 *
 * `tokenScope: 'lifecycle'` (#1276) lets the sb stack-install panel start
 * an install with a scoped `sb_` token. Progress is then polled on the public
 * jobId-gated `/api/install/progress` (no token needed there).
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const body = (await request.json()) as { source?: string; input?: JobInput };
    const input = body.input;
    if (!input || !Array.isArray(input.items) || !Array.isArray(input.variables)) {
      return NextResponse.json({ error: 'invalid input' }, { status: 400 });
    }
    // #1520 — clean-install (wipe-then-deploy) is retired: an install never
    // wipes existing data. A reinstall is a plain redeploy over the data on
    // disk (the runner's `!cleanInstall` path: reuse saved secrets, preserve
    // certs — the safe credential-reconciliation defaults); the only
    // system-wide wipe is the explicit Factory Reset. Enforce server-side so
    // no caller (old client, replayed JobInput) can trigger the wipe branch.
    input.cleanInstall = false;
    input.cleanInstallConfirm = '';
    delete input.preserve;
    const existing = await getCurrentJob();
    if (existing) {
      return NextResponse.json(
        { error: 'install already in progress', jobId: existing.id },
        { status: 409 },
      );
    }
    try {
      // #1297 — a reinstall replays a saved JobInput verbatim, so a variable
      // ADDED to a template after the manifest was saved arrives empty. Merge
      // variables.json defaults for any missing/empty var (manifest value wins)
      // so newly-added defaults take effect without a full re-wizard.
      const withDefaults = await applyVariableDefaults(input);
      const job = await createJob({ source: body.source ?? 'wizard', input: withDefaults });
      startJob(job.id);
      return NextResponse.json({ jobId: job.id });
    } catch (e) {
      if (e instanceof InstallInProgressError) {
        return NextResponse.json(
          { error: 'install already in progress', jobId: e.existingJobId },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (error) {
    return apiError(error, { tag: 'api:install:start', status: 500 });
  }
});
