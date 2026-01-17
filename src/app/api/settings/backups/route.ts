import { NextResponse } from 'next/server';
import { createSystemBackup, deleteSystemBackup, listSystemBackups } from '@/lib/systemBackup';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const backups = await listSystemBackups();
    const payload = backups.map(({ fileName, createdAt, size }) => ({ fileName, createdAt, size }));
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list backups';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const push = (data: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      };

      (async () => {
        try {
          const result = await createSystemBackup(entry => push({ type: 'log', entry }));
          push({ type: 'done', backup: { fileName: result.entry.fileName, createdAt: result.entry.createdAt, size: result.entry.size } });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create backup';
          push({ type: 'error', message });
        } finally {
          controller.close();
        }
      })();
    }
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store'
    }
  });
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const url = new URL(request.url);
    const fileName = body.fileName ?? url.searchParams.get('file');
    if (!fileName) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }
    await deleteSystemBackup(fileName);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete backup';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
