
import { NextRequest, NextResponse } from 'next/server';
import { renameService } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  try {
    const body = await request.json();
    const { newName } = body;

    if (!newName) {
      return NextResponse.json({ error: 'New name is required' }, { status: 400 });
    }

    await renameService(name, newName, connection);
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
