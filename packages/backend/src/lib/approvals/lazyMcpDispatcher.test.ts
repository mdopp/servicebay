/**
 * Regression for #2237 / #2234: approving an `on_approve.mcp` approval must run
 * the tool in a module graph where `registerMcpDispatcher` was NOT called
 * eagerly at import time — it only becomes available once the MCP server module
 * is imported (its top-level side effect).
 *
 * In production the dispatcher is registered by a top-level side effect of
 * `mcp/server`. The backend server imports it at startup, but the Next.js
 * `/api/approvals/[id]/approve` route runs in a SEPARATE Turbopack bundle
 * instance of `lib/approvals` where that startup import never ran — so
 * `mcpDispatcher` was null there and the approve threw HTTP 400 ("MCP tool
 * dispatcher is not registered"), the tool never running (box-verified RED on
 * #2234). The fix makes that route import the registration seam so the
 * dispatcher is present in its bundle; this test pins the underlying contract:
 * with no eager registration, importing the seam registers a dispatcher and
 * `approveApproval` then actually dispatches the tool.
 *
 * A dedicated test file (fresh module graph) is required because the sibling
 * index.test.ts eagerly calls `registerMcpDispatcher` at module load, which
 * would otherwise mask the null-dispatcher context this test reproduces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

const { TMP } = vi.hoisted(() => ({
  TMP: `${process.env.TMPDIR || '/tmp'}/approvals-lazy-test-${process.pid}`,
}));
vi.mock('@/lib/dirs', () => ({ DATA_DIR: TMP }));
vi.mock('@/lib/executor', () => ({ getExecutor: vi.fn(() => ({})) }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { restartService: vi.fn() } }));

// The tool the registered dispatcher runs. Its call is the assertion that the
// tool actually ran (rather than a 400 "dispatcher not registered").
const dispatchMcpTool = vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }));

// Stand in for @/lib/mcp/server: importing it registers the dispatcher via the
// seam — mirroring the real module's top-level `registerMcpDispatcher(...)`
// call — without pulling the whole MCP server graph into this unit test. The
// route (packages/frontend/.../approvals/[id]/approve/route.ts) does exactly
// this side-effect import so its bundle instance has a dispatcher.
let registeredViaServerImport = false;

import { submitApproval, approveApproval, getApproval, registerMcpDispatcher } from './index';

/** Simulate the route's `import '@/lib/mcp/server'` side effect. */
function importMcpServerSeam(): void {
  registerMcpDispatcher(dispatchMcpTool);
  registeredViaServerImport = true;
}

beforeEach(() => {
  dispatchMcpTool.mockClear();
  dispatchMcpTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('#2237 MCP dispatcher registered via the server-import seam on approve', () => {
  it('a pre-registration approve fails (reproduces the Next.js route null context)', async () => {
    // No dispatcher registered in this module graph yet — exactly the RED path.
    expect(registeredViaServerImport).toBe(false);
    const r = await submitApproval({
      service: 'honcho',
      title: 'delete_service: honcho',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/dispatcher is not registered/);
    // The request must NOT be marked approved when the tool could not run.
    expect((await getApproval(r.id))?.status).toBe('pending');
    expect(dispatchMcpTool).not.toHaveBeenCalled();
  });

  it('after the server-import seam registers the dispatcher, approve runs the tool', async () => {
    importMcpServerSeam();
    expect(registeredViaServerImport).toBe(true);

    const r = await submitApproval({
      service: 'honcho',
      title: 'delete_service: honcho',
      payload: { toolName: 'delete_service', args: { name: 'honcho' }, caller: 'token:ci-bot' },
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    const res = await approveApproval(r.id);

    // The tool actually ran (the #2234 RED was that it never did).
    expect(dispatchMcpTool).toHaveBeenCalledWith('delete_service', { name: 'honcho' });
    expect(res.request.status).toBe('approved');
    expect((await getApproval(r.id))?.status).toBe('approved');
  });
});
