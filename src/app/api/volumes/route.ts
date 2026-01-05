import { NextRequest, NextResponse } from 'next/server';
import { listVolumes, createVolume } from '@/lib/manager';
import { getNodeConnection } from '@/lib/nodes';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const nodeName = searchParams.get('node');
  const connection = await getNodeConnection(nodeName || undefined);
  
  const volumes = await listVolumes(connection);
  return NextResponse.json(volumes);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, options, node } = body;
  
  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const connection = await getNodeConnection(node);
  try {
    await createVolume(name, options, connection);
    return NextResponse.json({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
