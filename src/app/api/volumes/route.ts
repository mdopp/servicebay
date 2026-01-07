import { NextRequest, NextResponse } from 'next/server';
import { listVolumes, createVolume, VolumeInfo } from '@/lib/manager';
import { getNodeConnection, listNodes } from '@/lib/nodes';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const nodeName = searchParams.get('node');
  
  try {
    // If a specific node is requested, return volumes for that node only
    if (nodeName) {
        const connection = await getNodeConnection(nodeName);
        const volumes = await listVolumes(connection);
        return NextResponse.json(volumes);
    }
    
    // Otherwise, fetch volumes from ALL nodes in parallel
    const nodes = await listNodes();
    
    if (nodes.length === 0) {
        return NextResponse.json([]);
    }
    
    const results = await Promise.allSettled(nodes.map(node => listVolumes(node)));
    
    let allVolumes: VolumeInfo[] = [];
    results.forEach(result => {
        if (result.status === 'fulfilled') {
            allVolumes = [...allVolumes, ...result.value];
        }
    });

    return NextResponse.json(allVolumes);
  } catch (e) {
     const message = e instanceof Error ? e.message : 'Unknown error';
     return NextResponse.json({ error: message }, { status: 500 });
  }
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
