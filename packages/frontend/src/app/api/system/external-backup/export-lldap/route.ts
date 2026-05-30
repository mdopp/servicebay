import { NextResponse } from 'next/server';
import { exportLldapDirectory } from '@/lib/lldap/client';
import { stageLldapDirectoryToNas } from '@/lib/externalBackup/lldapStage';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST — export the configured LLDAP's users + groups and stage them on the NAS
 * (#1354), so a fresh install can re-seed the same accounts. No body: it uses
 * the stored LLDAP admin credentials. Passwords are not exported (OPAQUE);
 * migrated users set a new password on first login. `tokenScope: 'lifecycle'`
 * so the sb-tui flow can trigger it with a scoped token.
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async () => {
  try {
    const result = await exportLldapDirectory();
    if (!result.ok) {
      // not_configured / auth_failed / unreachable are operator-fixable → 400/502.
      const status = result.reason === 'unreachable' || result.reason === 'network_error' ? 502 : 400;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }
    const staged = await stageLldapDirectoryToNas(result.directory);
    return NextResponse.json({ ok: true, ...staged });
  } catch (e) {
    return apiError(e, { tag: 'api:system:external-backup:export-lldap', status: 500 });
  }
});
