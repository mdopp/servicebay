import { NextResponse } from 'next/server';
import { getPodmanPs, getAllContainersInspect } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  const [containers, inspects] = await Promise.all([
    getPodmanPs(connection),
    getAllContainersInspect(connection)
  ]);

  // Create a map of inspect data for quick lookup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspectMap = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inspects.forEach((i: any) => inspectMap.set(i.Id, i));

  // Enrich containers with NetworkMode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = containers.map((c: any) => {
    const inspect = inspectMap.get(c.Id);
    let networkMode = 'unknown';
    
    if (inspect && inspect.HostConfig && inspect.HostConfig.NetworkMode) {
        networkMode = inspect.HostConfig.NetworkMode;
    } else if (inspect && inspect.NetworkSettings && inspect.NetworkSettings.Networks) {
        // Fallback to keys of Networks object
        networkMode = Object.keys(inspect.NetworkSettings.Networks).join(', ');
    }

    return {
        ...c,
        NetworkMode: networkMode,
        IsHostNetwork: networkMode === 'host'
    };
  });

  return NextResponse.json(enriched);
}
