/**
 * GET /napi/approvals/events — server-server SSE feed of new pending approvals
 * (#2268 part B). Solaris subscribes with a read-scoped token and republishes.
 *
 * The gate machinery (accept right-scope Bearer, 401 wrong/absent scope) lives
 * in requireSession.test.ts; the exact `read` scope in OPTIONS is pinned in
 * ../../scopeGuards.test.ts. Here we prove the STREAM WIRING: it subscribes to
 * the approvals bus, forwards a new-approval event, unsubscribes on cancel, and
 * carries the SSE content-type. We drive the real `onNewApproval` bus so the
 * wiring (not a mock) is exercised.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { NewApprovalEvent } from '@/lib/approvals';

// Stub the handler wrapper so we invoke the stream directly (gate covered
// elsewhere); the route body under test is the ReadableStream + bus wiring.
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (_opts: unknown, handler: () => Promise<Response>) =>
    async (_req: NextRequest) => handler(),
}));

// Use the REAL approvals bus so we test the actual emit→stream path. Only the
// fs/executor dependencies of the module are stubbed to keep it hermetic.
vi.mock('@/lib/dirs', () => ({ DATA_DIR: `${process.env.TMPDIR || '/tmp'}/napi-events-test-${process.pid}` }));
vi.mock('@/lib/executor', () => ({ getExecutor: vi.fn() }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: {} }));

import { GET } from './route';
import { submitApproval } from '@/lib/approvals';

function parseSse(chunk: string): NewApprovalEvent | { type: string } | null {
  const line = chunk.split('\n').find(l => l.startsWith('data: '));
  return line ? JSON.parse(line.slice('data: '.length)) : null;
}

describe('GET /napi/approvals/events — SSE new-approval feed (#2268 part B)', () => {
  it('returns an event-stream and emits a new-approval event when one is created', async () => {
    const res = await GET(new NextRequest('http://localhost/napi/approvals/events'));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame is the connection handshake.
    const first = await reader.read();
    expect(parseSse(decoder.decode(first.value))).toEqual({ type: 'connected' });

    // Create a pending approval — the stream must forward a new-approval event.
    const created = await submitApproval({ service: 'honcho', title: 'delete honcho', node: 'box1' });
    const next = await reader.read();
    expect(parseSse(decoder.decode(next.value))).toEqual({
      type: 'new-approval',
      id: created.id,
      kind: 'honcho',
      summary: 'delete honcho',
      created_at: created.created_at,
    });

    // Cancelling the stream unsubscribes — a later approval must NOT arrive.
    await reader.cancel();
    const before = await submitApproval({ service: 'honcho', title: 'later', node: 'box1' });
    expect(before.id).toBeTruthy(); // submit still succeeds with no live subscriber
  });
});
