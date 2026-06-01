import { NextResponse } from 'next/server';
import { registerNasSource } from '@/lib/externalBackup/registerSource';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST { host, username, password } — register the FritzBox NAS as the
 * external-backup source by recording its creds in `config.gateway` (#1440).
 * The sb-tui NAS upload calls this after pushing `home-assistant.tar`, so the
 * box knows where its backups live and the upload is discoverable by
 * install/restore (it was previously invisible — the box's gateway was empty).
 * Idempotent. `tokenScope: 'mutate'` (it writes config) so the sb-tui flow can
 * trigger it with a scoped `sb_` token; a browser session cookie also works.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      host?: unknown;
      username?: unknown;
      password?: unknown;
    };
    if (typeof body.host !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return NextResponse.json({ error: 'host, username and password (strings) are required' }, { status: 400 });
    }
    const result = await registerNasSource({ host: body.host, username: body.username, password: body.password });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // registerNasSource throws curated, operator-fixable messages (missing
    // field); surface them like the sibling external-backup routes.
    return apiError(e, { tag: 'api:system:external-backup:register', status: 400, exposeMessage: true });
  }
});
