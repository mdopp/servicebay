import { NextResponse } from 'next/server';
import os from 'os';
import path from 'path';
import { getBackupFileMeta, readSystemBackupFile } from '@/lib/systemBackup';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  try {
    const body = await request.json().catch(() => ({}));
    const fileName = body.fileName as string | undefined;
    const uploadToken = body.uploadToken as string | undefined;
    const nodeName = body.nodeName as string | undefined;
    const relativePath = body.relativePath as string | undefined;

    if (!nodeName || !relativePath) {
      return NextResponse.json({ error: 'nodeName and relativePath are required' }, { status: 400 });
    }

    let archivePath: string;
    if (uploadToken) {
      archivePath = path.join(os.tmpdir(), `servicebay-upload-${uploadToken}.tar.gz`);
    } else if (fileName) {
      const entry = await getBackupFileMeta(fileName);
      archivePath = entry.path;
    } else {
      return NextResponse.json({ error: 'fileName or uploadToken is required' }, { status: 400 });
    }

    const content = await readSystemBackupFile(archivePath, nodeName, relativePath);
    return NextResponse.json({ content });
  } catch (error) {
    return apiError(error, { tag: 'api:settings:backups:file', status: 500 });
  }
}