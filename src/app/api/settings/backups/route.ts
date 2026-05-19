import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSystemBackup, deleteSystemBackup, listSystemBackups } from '@/lib/systemBackup';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async () => {
  const backups = await listSystemBackups();
  const payload = backups.map(({ fileName, createdAt, size }) => ({ fileName, createdAt, size }));
  return NextResponse.json(payload);
});

/**
 * POST — create a new system backup. Streams progress as NDJSON. Body
 * deliberately unused; `withApiHandler` skips body parsing when
 * `options.body` isn't set.
 */
export const POST = withApiHandler({}, async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const push = (data: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      };
      (async () => {
        try {
          const result = await createSystemBackup(entry => push({ type: 'log', entry }));
          push({
            type: 'done',
            backup: {
              fileName: result.entry.fileName,
              createdAt: result.entry.createdAt,
              size: result.entry.size,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create backup';
          push({ type: 'error', message });
        } finally {
          controller.close();
        }
      })();
    },
  });
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });
});

const DeleteBody = z.object({ fileName: z.string().min(1).optional() });

export const DELETE = withApiHandler({ body: DeleteBody.optional() }, async ({ body, request }) => {
  // Accept fileName from body OR ?file= query for back-compat — the
  // settings UI sends it in the body, but operator-supplied curl might
  // use the query form.
  const url = new URL(request.url);
  const fileName = body?.fileName ?? url.searchParams.get('file');
  if (!fileName) {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
  }
  await deleteSystemBackup(fileName);
  return NextResponse.json({ success: true });
});
