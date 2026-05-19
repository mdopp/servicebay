import fs from 'fs';
import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBackupFileMeta } from '@/lib/systemBackup';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({ file: z.string().min(1) });

export const GET = withApiHandler({ query: QuerySchema }, async ({ query }) => {
  try {
    const meta = await getBackupFileMeta(query.file);
    const nodeStream = fs.createReadStream(meta.path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    return new NextResponse(webStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${meta.fileName}"`,
        'Content-Length': meta.size.toString(),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup not found';
    return NextResponse.json({ error: message }, { status: 404 });
  }
});
