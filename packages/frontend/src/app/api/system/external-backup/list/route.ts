import { NextResponse } from 'next/server';
import { getNasBackupOverview } from '@/lib/externalBackup/registerSource';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * GET — the NAS backup source overview for Settings → Backups (#1440): is a
 * FritzBox NAS source registered, does it connect, and which service backups
 * (incl. `home-assistant.tar`) are staged under `sb-backup/`. Read-only; the
 * restore happens via the existing `/external-backup/restore` route.
 * `tokenScope: 'read'` so the sb-tui flow can poll it with a scoped token; a
 * browser session cookie is also accepted.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const overview = await getNasBackupOverview();
    return NextResponse.json({ ok: true, ...overview });
  } catch (e) {
    return apiError(e, { tag: 'api:system:external-backup:list', status: 400, exposeMessage: true });
  }
});
