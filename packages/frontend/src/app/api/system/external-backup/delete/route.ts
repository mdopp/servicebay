import { NextResponse } from 'next/server';
import { deleteServiceBackup } from '@/lib/externalBackup/producer';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST { service, tarName } — delete one NAS snapshot and its `.meta.json`
 * sidecar from `sb-backup/` (#1890). The per-row Delete on Settings → Backups'
 * Snapshot-on-NAS table. `tarName` is validated in the producer (basename only,
 * no traversal, must end in `.tar`) since it's a NAS path. `tokenScope: 'mutate'`
 * mirrors the backup-now route.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { service?: unknown; tarName?: unknown };
    if (typeof body.tarName !== 'string' || !body.tarName) {
      return NextResponse.json({ error: 'tarName field is required' }, { status: 400 });
    }
    const result = await deleteServiceBackup(body.tarName);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Operator-fixable, curated messages (invalid name, NAS not configured);
    // surface them like the other external-backup routes.
    return apiError(e, { tag: 'api:system:external-backup:delete', status: 400, exposeMessage: true });
  }
});
