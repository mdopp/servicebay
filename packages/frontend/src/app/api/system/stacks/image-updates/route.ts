/**
 * GET /api/system/stacks/image-updates (#1859, child 1 of #1858)
 *
 * "Which installed services are running an image older than what the registry
 * now serves for their tag?" — fanned out across every entry in
 * `config.installedTemplates`, mirroring the
 * `/api/system/templates/upgrades-pending` route's fan-out + session gate.
 *
 * For each service it compares the running image digest (`podman inspect`)
 * against the registry's current digest for the same tag
 * (`podman manifest inspect`), reusing updater.ts's digest extraction via
 * `@/lib/imageDigest`. The frontend badge + overview (child #2, #1860)
 * consumes this; this route makes NO `(dashboard)/` changes.
 */
import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getInstalledImageUpdates } from '@/lib/imageDigest';

export const dynamic = 'force-dynamic';

// tokenScope must live in the withApiHandler OPTIONS so handler.ts's built-in
// requireSession runs with it (#2249): a scoped SB-MCP Bearer token may poll
// this pending-image-updates signal so an external consumer (Solaris Wartung
// chat) can render "update available" cards. The gate stays deny-by-default: a
// missing/wrong-scope Bearer 401s and a session cookie keeps working unchanged.
// (Previously the scope sat on an INNER requireSession call while the wrapper
// gate ran scopeless first → the Bearer path was skipped → 401 on a valid
// read token; box-verify #2243 RED.)
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const services = await getInstalledImageUpdates();
    return NextResponse.json({ services });
  } catch (e) {
    return apiError(e, { tag: 'api:system:stacks:image-updates', status: 500 });
  }
});
