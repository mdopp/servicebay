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
import { requireSession } from '@/lib/api/requireSession';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getInstalledImageUpdates } from '@/lib/imageDigest';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async ({ request }) => {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const services = await getInstalledImageUpdates();
    return NextResponse.json({ services });
  } catch (e) {
    return apiError(e, { tag: 'api:system:stacks:image-updates', status: 500 });
  }
});
