import { NextResponse } from 'next/server';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { getBackupFileMeta, restoreSystemBackup, restoreSystemBackupSelection, type BackupRestoreSelection } from '@/lib/systemBackup';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const PostBody = z.object({
  fileName: z.string().min(1).optional(),
  uploadToken: z.string().regex(/^[a-z0-9-]+$/i).optional(),
  selection: z.unknown().optional(),
});

// tokenScope: 'destroy' (#1277) — restore overwrites the box's config/state, so
// it requires the most privileged scope. The sb-tui backup panel confirms
// before calling this; the web UI's cookie path is unchanged.
export const POST = withApiHandler({ body: PostBody, tokenScope: 'destroy' }, async ({ body }) => {
  const { fileName, uploadToken } = body;
  const selection = body.selection as BackupRestoreSelection | undefined;

  let archivePath: string | undefined;
  let cleanupPath: string | undefined;
  if (fileName) {
    const entry = await getBackupFileMeta(fileName);
    archivePath = entry.path;
  } else if (uploadToken) {
    archivePath = path.join(os.tmpdir(), `servicebay-upload-${uploadToken}.tar.gz`);
    cleanupPath = archivePath;
  } else {
    return NextResponse.json({ error: 'fileName or uploadToken is required' }, { status: 400 });
  }

  if (selection) {
    await restoreSystemBackupSelection(archivePath, selection);
    if (cleanupPath) await fs.rm(cleanupPath, { force: true });
    return NextResponse.json({ success: true });
  }

  if (cleanupPath) {
    return NextResponse.json({ error: 'selection is required for uploaded backups' }, { status: 400 });
  }

  const restored = await restoreSystemBackup(fileName || path.basename(archivePath));
  const payload = { fileName: restored.fileName, createdAt: restored.createdAt, size: restored.size };
  return NextResponse.json({ success: true, restored: payload });
});
