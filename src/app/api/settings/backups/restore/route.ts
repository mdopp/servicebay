import { NextResponse } from 'next/server';
import { restoreSystemBackup } from '@/lib/systemBackup';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const fileName = body.fileName as string | undefined;
    if (!fileName) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }

    const restored = await restoreSystemBackup(fileName);
    const payload = { fileName: restored.fileName, createdAt: restored.createdAt, size: restored.size };
    return NextResponse.json({ success: true, restored: payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore backup';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
