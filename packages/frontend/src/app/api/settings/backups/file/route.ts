import { NextResponse } from 'next/server';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import { getBackupFileMeta, readSystemBackupFile } from '@/lib/systemBackup';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const PostBody = z.object({
  fileName: z.string().min(1).optional(),
  uploadToken: z.string().min(1).optional(),
  nodeName: z.string().min(1),
  relativePath: z.string().min(1),
});

/**
 * POST — fetch one file from a backup archive (either stored on disk
 * by fileName, or an upload referenced by uploadToken from /preview).
 */
export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  const { fileName, uploadToken, nodeName, relativePath } = body;
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
});
