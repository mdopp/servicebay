import { NextResponse } from 'next/server';
import { backupInstalledServicesToNas } from '@/lib/externalBackup/producer';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST — on-demand "back up config now" (#1217, epic #1190): back up every
 * installed service that has a backup manifest to the FritzBox NAS in one pass.
 * Per-service failures are reported in the result rather than aborting the run.
 * `tokenScope: 'mutate'` so the sb-tui flow can trigger it with a scoped token.
 *
 * This is the backend half; the nightly cron + the per-service Settings button
 * are the path-mandated remainder of #1217.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async () => {
  try {
    const results = await backupInstalledServicesToNas();
    const ok = results.filter(r => r.ok).length;
    return NextResponse.json({ ok: true, backedUp: ok, total: results.length, results });
  } catch (e) {
    // Whole-run failure (e.g. NAS not configured) — operator-fixable, curated;
    // surface it like the other external-backup routes.
    return apiError(e, { tag: 'api:system:external-backup:backup-now', status: 400, exposeMessage: true });
  }
});
