import { NextResponse } from 'next/server';
import { provisionPortalRouting } from '@/lib/portal/provisioner';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Manual trigger for the apex/www provisioner. Same logic as the
 * server-startup hook (#242 follow-up); useful when:
 *
 *   - The 60s startup delay missed because nginx / adguard came up
 *     later than expected.
 *   - Admin switched LAN→public domain and needs the apex routing
 *     updated for the new domain.
 *   - Re-provisioning manually after fixing NPM creds via the
 *     `npm_data_stale.use_existing` action.
 *
 * Idempotent. Returns the structured result the provisioner produces
 * so the UI (or curl) can show what changed.
 */
export const POST = withApiHandler({}, async () => {
  const result = await provisionPortalRouting();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
});
