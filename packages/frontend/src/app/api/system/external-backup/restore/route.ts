import { NextResponse } from 'next/server';
import { restoreServiceBackup } from '@/lib/externalBackup/restore';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST { service, force? } — restore a service's config backup from the
 * FritzBox NAS back into its data dir (#1218, epic #1190). The consumer half
 * of the backup-survival loop: `import-ha`/`upload`/`export-lldap` put backups
 * on the NAS; this pulls one back. Restores the most-recent dated snapshot by
 * default; pass `tarName` to restore a specific one (#1865). Refuses a non-empty
 * data dir unless `force` is set, so it never clobbers a live service.
 *
 * `tokenScope: 'destroy'` (#2050): with `force` this overwrites a live service's
 * data dir — an irreversible state edit, the `destroy` tier — matching the sibling
 * config-restore route and the MCP `restore_backup` tool. The only HTTP caller is
 * the cookie-authenticated Backup page (cookies carry all scopes); the reinstall
 * auto-restore path calls `restoreServiceBackup()` in-process, never via this guard.
 */
export const POST = withApiHandler({ tokenScope: 'destroy' }, async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { service?: unknown; force?: unknown; tarName?: unknown };
    if (typeof body.service !== 'string' || !body.service) {
      return NextResponse.json({ error: 'service field is required' }, { status: 400 });
    }
    const result = await restoreServiceBackup(body.service, {
      force: body.force === true,
      ...(typeof body.tarName === 'string' && body.tarName ? { tarName: body.tarName } : {}),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Operator-fixable, curated messages (unknown service, non-empty data dir,
    // NAS not configured, a refused/corrupt archive); surface them rather than
    // an opaque "Bad request" — same rationale as import-ha/upload.
    return apiError(e, { tag: 'api:system:external-backup:restore', status: 400, exposeMessage: true });
  }
});
