import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getBackupFileMeta, previewSystemBackup } from '@/lib/systemBackup';

export const dynamic = 'force-dynamic';

const createUploadPath = (token: string) => path.join(os.tmpdir(), `servicebay-upload-${token}.tar.gz`);

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'file is required' }, { status: 400 });
      }
      const token = crypto.randomBytes(8).toString('hex');
      const archivePath = createUploadPath(token);
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(archivePath, buffer);

      const preview = await previewSystemBackup(archivePath);
      return NextResponse.json({
        preview,
        source: { type: 'upload', token }
      });
    }

    const body = await request.json().catch(() => ({}));
    const fileName = body.fileName as string | undefined;
    if (!fileName) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }

    const entry = await getBackupFileMeta(fileName);
    const preview = await previewSystemBackup(entry.path);
    return NextResponse.json({
      preview,
      source: { type: 'stored', fileName: entry.fileName }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to preview backup';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
