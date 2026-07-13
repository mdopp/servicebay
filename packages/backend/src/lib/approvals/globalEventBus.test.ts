/**
 * Regression for #2268 part B: the approvals event bus (`approvalEvents`) must
 * be a `globalThis`-shared singleton so it survives across the Next.js
 * per-route module-cache boundary.
 *
 * WHY THIS IS ITS OWN FILE + WHAT IT CAN AND CANNOT PROVE:
 * The real bug is cross-BUNDLE — in the Next.js standalone build the SSE route
 * bundle and the MCP-server bundle each get their OWN module-cache copy of
 * approvals/index.ts, so a bare `new EventEmitter()` gave them DIFFERENT
 * instances (emit on one, listen on the other → nothing arrives). A vitest/jsdom
 * unit test shares ONE module cache, so it CANNOT reproduce two bundle copies —
 * the real end-to-end check is box-verify (BOUNDED SSE: subscribe-then-create,
 * `timeout N curl -N --max-time N`). What this test CAN pin is the SHARING
 * MECHANISM that makes cross-bundle work: the emitter is anchored on
 * `globalThis` (the one object every bundle in the process shares), and a
 * pre-existing global emitter is REUSED, not replaced. If someone reverts to a
 * bare module-level `new EventEmitter()`, `globalThis.__sbApprovalEvents` goes
 * undefined and this test fails — a cheap tripwire for the box-verified bug.
 *
 * The fs/executor deps are stubbed only to keep the import hermetic; the assert
 * is purely on the global anchor, so no store I/O happens.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('@/lib/dirs', () => ({ DATA_DIR: `${process.env.TMPDIR || '/tmp'}/approvals-globalbus-test-${process.pid}` }));
vi.mock('@/lib/executor', () => ({ getExecutor: vi.fn() }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: {} }));

const g = globalThis as unknown as { __sbApprovalEvents?: EventEmitter };

describe('#2268-B approvals event bus is a globalThis-shared singleton', () => {
  it('importing the module anchors the emitter on globalThis (cross-bundle sharing mechanism)', async () => {
    // Importing the module runs its top-level singleton setup.
    await import('./index');
    expect(g.__sbApprovalEvents).toBeInstanceOf(EventEmitter);
    // The listener cap is lifted (unbounded concurrent SSE subscribers).
    expect(g.__sbApprovalEvents!.getMaxListeners()).toBe(0);
  });

  it('the onNewApproval subscription binds to the SAME global emitter the module emits on', async () => {
    const { onNewApproval } = await import('./index');
    const listener = vi.fn();
    const off = onNewApproval(listener);
    // A subscriber registered via the public API must land on the shared global
    // emitter — this is exactly what breaks cross-bundle when they diverge.
    g.__sbApprovalEvents!.emit('new-approval', { type: 'new-approval', id: 'x', kind: 'k', summary: 's', created_at: 't' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
