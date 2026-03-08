import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';

export const dynamic = 'force-dynamic';

/** List device files from a directory on the target node (e.g. /dev/serial/by-id). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const devicePath = searchParams.get('path') || '/dev/serial/by-id';

  if (!nodeName) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  try {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('exec', {
      command: `ls -1 ${devicePath} 2>/dev/null || echo ""`
    });

    const devices = (res.stdout || '')
      .split('\n')
      .map((d: string) => d.trim())
      .filter(Boolean)
      .map((name: string) => `${devicePath}/${name}`);

    return NextResponse.json({ devices });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
