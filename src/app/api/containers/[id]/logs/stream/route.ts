
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { listNodes } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const encoder = new TextEncoder();

  let spawnCmd = 'podman';
  let spawnArgs = ['logs', '-f', '--tail', '100', id];

  if (nodeName && nodeName !== 'local') {
      const nodes = await listNodes();
      const connection = nodes.find(n => n.Name === nodeName);
      
      if (connection) {
          try {
              const uri = new URL(connection.URI);
              const user = uri.username;
              const host = uri.hostname;
              const port = uri.port || '22';
              
              spawnCmd = 'ssh';
              spawnArgs = [
                  '-o', 'StrictHostKeyChecking=no', // Avoid interactive prompts
                  '-o', 'UserKnownHostsFile=/dev/null',
                  '-p', port,
                  ...(connection.Identity ? ['-i', connection.Identity] : []),
                  `${user ? user + '@' : ''}${host}`,
                  `podman logs -f --tail 100 ${id}`
              ];
          } catch (e) {
              console.error('Failed to parse connection URI', e);
              // Fallback to local? Or error?
              // If parsing fails, we probably can't connect.
              return NextResponse.json({ error: 'Invalid connection URI' }, { status: 500 });
          }
      }
  }

  // Re-implement with proper cleanup scope
  const streamWithCleanup = new ReadableStream({
    start(controller) {
      const process = spawn(spawnCmd, spawnArgs);

      const onData = (data: Buffer) => {
        try {
            controller.enqueue(encoder.encode(data.toString()));
        } catch {
            process.kill();
        }
      };

      process.stdout.on('data', onData);
      process.stderr.on('data', onData);

      process.on('close', () => {
        try {
            controller.close();
        } catch {}
      });

      // Attach kill to controller so we can access it in cancel if needed, 
      // or just rely on the fact that we need to store reference.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any)._process = process;
    },
    cancel(controller) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const process = (controller as any)._process;
        if (process) process.kill();
    }
  });

  return new NextResponse(streamWithCleanup, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
