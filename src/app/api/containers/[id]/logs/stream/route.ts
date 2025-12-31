
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  // Re-implement with proper cleanup scope
  const streamWithCleanup = new ReadableStream({
    start(controller) {
      const podmanLogs = spawn('podman', ['logs', '-f', '--tail', '100', id]);

      const onData = (data: Buffer) => {
        try {
            controller.enqueue(encoder.encode(data.toString()));
        } catch {
            podmanLogs.kill();
        }
      };

      podmanLogs.stdout.on('data', onData);
      podmanLogs.stderr.on('data', onData);

      podmanLogs.on('close', () => {
        try {
            controller.close();
        } catch {}
      });

      // Attach kill to controller so we can access it in cancel if needed, 
      // or just rely on the fact that we need to store reference.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any)._process = podmanLogs;
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
