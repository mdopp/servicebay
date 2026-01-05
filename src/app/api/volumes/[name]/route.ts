import { NextRequest, NextResponse } from 'next/server';
import { removeVolume } from '@/lib/manager';
import { getNodeConnection } from '@/lib/nodes';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const searchParams = req.nextUrl.searchParams;
  const nodeName = searchParams.get('node');
  const connection = await getNodeConnection(nodeName || undefined);
  
  try {
    await removeVolume(name, connection);
    return NextResponse.json({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
