import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { onNewApproval, type NewApprovalEvent } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * GET /napi/approvals/events — server-server SSE feed of NEW pending approvals
 * (#2268 part B, ADR 0010).
 *
 * Solaris (server-server, read-scoped token) subscribes here and republishes
 * each new-approval event on its OWN bus; per ADR 0010 the PHONE never
 * subscribes to ServiceBay directly — Solaris aggregates. The stream emits a
 * MINIMAL, secret-free payload (`onNewApproval` builds it): approval id + kind
 * (service) + summary (title). No approval payload, no on_approve/on_reject
 * actions, no secrets ride the stream.
 *
 * TOKEN-GATED, `read`-scoped (`tokenScope: 'read'` in the withApiHandler OPTIONS
 * — the wrapper gate reads it there, #2249/#2252). A request with NO valid
 * Bearer is 401'd by the gate before the stream opens; this is a read-only
 * notification, not a mutation, so a `read` token is the correct floor (and it
 * matches the other /napi read surfaces). Modelled on /api/stream but scoped to
 * the approvals bus.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Controller closed (client gone) — tear the subscription down.
          if (cleanup) cleanup();
        }
      };

      // Initial handshake so the subscriber knows the stream is live.
      send({ type: 'connected' });

      const unsubscribe = onNewApproval((event: NewApprovalEvent) => send(event));

      // Keep-alive ping so intermediaries don't drop an idle connection.
      const interval = setInterval(() => send({ type: 'ping' }), 30000);

      cleanup = () => {
        unsubscribe();
        clearInterval(interval);
      };
    },
    cancel() {
      if (cleanup) cleanup();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
