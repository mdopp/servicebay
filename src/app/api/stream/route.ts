
import { NextResponse } from 'next/server';
import watcher from '@/lib/watcher';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();
  
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (data: unknown) => {
        try {
            const message = `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(message));
        } catch {
            // Controller might be closed
            if (cleanup) cleanup();
        }
      };

      // Send initial connection message
      sendEvent({ type: 'connected', message: 'Stream connected' });

      // Subscribe to watcher events
      const handler = (data: unknown) => {
        sendEvent(data);
      };

      watcher.on('change', handler);

      // Keep-alive ping every 30s to prevent timeouts
      const interval = setInterval(() => {
        sendEvent({ type: 'ping' });
      }, 30000);

      cleanup = () => {
        watcher.off('change', handler);
        clearInterval(interval);
      };
    },
    cancel() {
        if (cleanup) cleanup();
    }
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
