import { NextResponse } from 'next/server';
import { stageUploadedServiceTar } from '@/lib/externalBackup/producer';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST multipart/form-data — stage an uploaded `<service>.tar` onto the FritzBox
 * NAS in the restore layout (#1351), so a fresh install pulls it. The HTTP
 * counterpart of the `sb-config-upload` CLI (#1219): it lets the sb-tui upload
 * flow (#1352) and the per-source extractors (#1353+) seed the NAS from the
 * operator's machine instead of from an on-box directory.
 *
 * Fields: `service` (must have a backup manifest) + `file` (the service tar).
 * `tokenScope: 'lifecycle'` so the TUI can call it with a scoped `sb_` token.
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const form = await request.formData();
    const service = form.get('service');
    const file = form.get('file');
    if (typeof service !== 'string' || !service) {
      return NextResponse.json({ error: 'service field is required' }, { status: 400 });
    }
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'file field (the service tar) is required' }, { status: 400 });
    }
    const tar = Buffer.from(await file.arrayBuffer());
    const result = await stageUploadedServiceTar(service, tar);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // stageUploadedServiceTar throws for an unknown service / non-tar upload /
    // unconfigured NAS — all operator-fixable, curated messages, and this route
    // is token/cookie-gated. Surface them instead of an opaque "Bad request"
    // (matches export-lldap / import-ha).
    return apiError(e, { tag: 'api:system:external-backup:upload', status: 400, exposeMessage: true });
  }
});
