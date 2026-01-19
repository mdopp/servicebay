import { NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { getBackupFileMeta, restoreSystemBackup, restoreSystemBackupSelection, type BackupRestoreSelection } from '@/lib/systemBackup';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const fileName = body.fileName as string | undefined;
    const uploadToken = body.uploadToken as string | undefined;
    const selection = body.selection as BackupRestoreSelection | undefined;

    let archivePath: string | undefined;
    let cleanupPath: string | undefined;
    if (fileName) {
      const entry = await getBackupFileMeta(fileName);
      archivePath = entry.path;
    } else if (uploadToken && /^[a-z0-9-]+$/i.test(uploadToken)) {
      archivePath = path.join(os.tmpdir(), `servicebay-upload-${uploadToken}.tar.gz`);
      cleanupPath = archivePath;
    } else {
      return NextResponse.json({ error: 'fileName or uploadToken is required' }, { status: 400 });
    }

    if (selection) {
      await restoreSystemBackupSelection(archivePath, selection);
      if (cleanupPath) {
        await fs.rm(cleanupPath, { force: true });
      }
      return NextResponse.json({ success: true });
    }

    if (cleanupPath) {
      return NextResponse.json({ error: 'selection is required for uploaded backups' }, { status: 400 });
    }

    const restored = await restoreSystemBackup(fileName || path.basename(archivePath));
    const payload = { fileName: restored.fileName, createdAt: restored.createdAt, size: restored.size };
    if (cleanupPath) {
      await fs.rm(cleanupPath, { force: true });
    }
    return NextResponse.json({ success: true, restored: payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore backup';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
