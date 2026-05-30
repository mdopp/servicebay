import { NextResponse } from 'next/server';
import os from 'os';
import path from 'path';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { importHaOsBackupToNas } from '@/lib/externalBackup/haOsImport';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST — import a Home Assistant OS (Supervisor) backup (#1353). The raw tar is
 * the request body (streamed to a temp file rather than buffered, since these
 * run tens to hundreds of MB); we extract its core config dir and stage the
 * manifest-filtered `home-assistant.tar` onto the NAS for a fresh install to
 * restore. `tokenScope: 'lifecycle'` so the sb-tui flow can call it.
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  if (!request.body) {
    return NextResponse.json({ error: 'request body (the HA backup tar) is required' }, { status: 400 });
  }
  const tmpPath = path.join(os.tmpdir(), `sb-haimport-upload-${Date.now()}.tar`);
  try {
    await pipeline(Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmpPath));
    const result = await importHaOsBackupToNas(tmpPath);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A non-HA / corrupt upload throws from the extractor — caller error → 400.
    // Surface the message: these are operator-fixable ("not a Home Assistant
    // backup", "FritzBox NAS not configured", a tar/FTP failure) and this route
    // is token/cookie-gated. An opaque "Bad request" hid the real cause behind a
    // multi-hour hunt the error string named outright. Matches export-lldap.
    return apiError(e, { tag: 'api:system:external-backup:import-ha', status: 400, exposeMessage: true });
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
});
