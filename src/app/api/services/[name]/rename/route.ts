import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  try {
    const body = await request.json();
    const { newName } = body;

    if (!newName) {
      return NextResponse.json({ error: 'New name is required' }, { status: 400 });
    }

    await ServiceManager.renameService(nodeName, name, newName);
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
