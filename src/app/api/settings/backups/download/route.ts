import fs from 'fs';
import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { getBackupFileMeta } from '@/lib/systemBackup';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileName = searchParams.get('file');

  if (!fileName) {
    return NextResponse.json({ error: 'file query parameter is required' }, { status: 400 });
  }

  try {
    const meta = await getBackupFileMeta(fileName);
    const nodeStream = fs.createReadStream(meta.path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new NextResponse(webStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${meta.fileName}"`,
        'Content-Length': meta.size.toString(),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup not found';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
