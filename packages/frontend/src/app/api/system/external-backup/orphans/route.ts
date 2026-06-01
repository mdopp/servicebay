import { NextResponse } from 'next/server';
import { listOrphanServiceBackups } from '@/lib/externalBackup/orphanBackups';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { listNodes } from '@/lib/nodes';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * GET — NAS config backups for services NOT currently installed (#1218 entry 2,
 * epic #1190). Powers the onboarding "N service backups available on the
 * FritzBox — install them?" hint: a reinstall or a foreign-backup seed (#1350)
 * can leave config on the NAS with no service to own it; installing one then
 * re-seeds its config via the entry-1 restore.
 *
 * Never errors the wizard — returns `{ orphans: [] }` if the NAS isn't
 * configured/reachable, so a missing NAS just hides the hint.
 */
export const GET = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const node = new URL(request.url).searchParams.get('node')
      || (await listNodes())[0]?.Name
      || 'Local';
    const installed = (await ServiceManager.listServices(node)).map(s => s.name);
    const orphans = await listOrphanServiceBackups(installed);
    return NextResponse.json({ orphans });
  } catch {
    return NextResponse.json({ orphans: [] });
  }
});
