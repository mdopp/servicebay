import { NextResponse } from 'next/server';
import { backupInstalledServicesToNas, backupServiceToNas } from '@/lib/externalBackup/producer';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST { service? } — on-demand "back up config now" (#1217, epic #1190).
 * With a `service`, backs up just that one service (the per-service Settings
 * "Back up config" button); without one, backs up every installed service that
 * has a backup manifest in one pass. Per-service failures in the back-up-all
 * path are reported in the result rather than aborting the run.
 * `tokenScope: 'mutate'` so the sb-tui flow can trigger it with a scoped token.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { service?: unknown };
    if (typeof body.service === 'string' && body.service) {
      const r = await backupServiceToNas(body.service);
      return NextResponse.json({ ok: true, backedUp: 1, total: 1, results: [{ service: r.service, ok: true, tarName: r.tarName, size: r.size }] });
    }
    const results = await backupInstalledServicesToNas();
    const ok = results.filter(r => r.ok).length;
    return NextResponse.json({ ok: true, backedUp: ok, total: results.length, results });
  } catch (e) {
    // Whole-run failure (e.g. NAS not configured) — operator-fixable, curated;
    // surface it like the other external-backup routes.
    return apiError(e, { tag: 'api:system:external-backup:backup-now', status: 400, exposeMessage: true });
  }
});
