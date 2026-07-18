import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// A fresh temp DATA_DIR per test run so the JSON store is isolated. Computed
// in a hoisted block (no module imports — those resolve after hoists) so the
// also-hoisted vi.mock factory can reference it.
const { TMP } = vi.hoisted(() => ({
  TMP: `${process.env.TMPDIR || '/tmp'}/approvals-test-${process.pid}`,
}));
vi.mock('@/lib/dirs', () => ({ DATA_DIR: TMP }));

const { fakeFs, executor, restartService } = vi.hoisted(() => {
  const fs: Record<string, string> = {};
  return {
    fakeFs: fs,
    executor: {
      exists: vi.fn((p: string) => Promise.resolve(p in fs)),
      rename: vi.fn((src: string, dst: string) => {
        fs[dst] = fs[src];
        delete fs[src];
        return Promise.resolve();
      }),
      mkdir: vi.fn(() => Promise.resolve()),
    },
    restartService: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@/lib/executor', () => ({ getExecutor: vi.fn(() => executor) }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { restartService } }));

import {
  listApprovals,
  getApproval,
  submitApproval,
  approveApproval,
  rejectApproval,
  registerMcpDispatcher,
  isSelfApproval,
  onNewApproval,
  type ApprovalRequest,
  type NewApprovalEvent,
} from './index';

// The mcp action calls the registered dispatcher (injected by the MCP layer in
// production) to re-dispatch the proposed tool (#2234).
const dispatchMcpTool = vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }));
registerMcpDispatcher(dispatchMcpTool);

beforeEach(() => {
  for (const k of Object.keys(fakeFs)) delete fakeFs[k];
  executor.exists.mockClear();
  executor.rename.mockClear();
  executor.mkdir.mockClear();
  restartService.mockClear();
  dispatchMcpTool.mockClear();
  dispatchMcpTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('approvals store', () => {
  it('returns [] on a fresh box (no store file)', async () => {
    expect(await listApprovals()).toEqual([]);
  });

  it('submits a pending request with generated id/created_at/status', async () => {
    const r = await submitApproval({ service: 'svc-a', title: 'do thing' });
    expect(r.id).toBeTruthy();
    expect(r.status).toBe('pending');
    expect(r.service).toBe('svc-a');
    expect(r.node).toBe('box1');
    expect(typeof r.created_at).toBe('string');
    expect(await listApprovals()).toHaveLength(1);
  });

  it('getApproval returns the request, null for unknown id', async () => {
    const r = await submitApproval({ service: 'svc', title: 't' });
    expect((await getApproval(r.id))?.id).toBe(r.id);
    expect(await getApproval('nope')).toBeNull();
  });

  it('lists newest first', async () => {
    const a = await submitApproval({ service: 's', title: 'a' });
    await new Promise(res => setTimeout(res, 5));
    const b = await submitApproval({ service: 's', title: 'b' });
    const list = await listApprovals();
    expect(list.map(r => r.id)).toEqual([b.id, a.id]);
  });
});

// Declared move endpoints are confined to the requesting service's jail
// (`/mnt/data/stacks/<service>`); paths below stay inside svc's jail.
const SVC_JAIL = '/mnt/data/stacks/svc';

describe('approve', () => {
  it('runs the declared move action (inside the service jail) and marks approved', async () => {
    fakeFs[`${SVC_JAIL}/draft`] = 'content';
    const r = await submitApproval({
      service: 'svc',
      title: 'promote',
      on_approve: { move: { src: `${SVC_JAIL}/draft`, dst: `${SVC_JAIL}/published/draft` } },
    });
    const res = await approveApproval(r.id);
    expect(res.request.status).toBe('approved');
    expect(executor.rename).toHaveBeenCalledWith(`${SVC_JAIL}/draft`, `${SVC_JAIL}/published/draft`);
    expect(`${SVC_JAIL}/published/draft` in fakeFs).toBe(true);
    expect((await getApproval(r.id))?.status).toBe('approved');
  });

  it('restarts the requesting service after the move', async () => {
    fakeFs[`${SVC_JAIL}/x`] = 'c';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: `${SVC_JAIL}/x`, dst: `${SVC_JAIL}/x2` }, restart: 'svc' },
    });
    const res = await approveApproval(r.id);
    expect(restartService).toHaveBeenCalledWith('box1', 'svc');
    expect(res.restarted).toBe(true);
  });

  it('surfaces a restart failure as a soft warning without rolling back the move', async () => {
    fakeFs[`${SVC_JAIL}/y`] = 'c';
    restartService.mockRejectedValueOnce(new Error('boom'));
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: `${SVC_JAIL}/y`, dst: `${SVC_JAIL}/y2` }, restart: 'svc' },
    });
    const res = await approveApproval(r.id);
    expect(res.restarted).toBe(false);
    expect(res.restartError).toBe('boom');
    expect(`${SVC_JAIL}/y2` in fakeFs).toBe(true);
    expect(res.request.status).toBe('approved');
  });

  it('throws when the source path is missing', async () => {
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: `${SVC_JAIL}/nope`, dst: `${SVC_JAIL}/dst` } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/not found/);
    expect((await getApproval(r.id))?.status).toBe('pending');
  });

  it('throws when the destination already exists', async () => {
    fakeFs[`${SVC_JAIL}/z`] = 'c';
    fakeFs[`${SVC_JAIL}/z2`] = 'old';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: `${SVC_JAIL}/z`, dst: `${SVC_JAIL}/z2` } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/already exists/);
  });

  it('rejects approving an unknown id', async () => {
    await expect(approveApproval('nope')).rejects.toThrow(/not found/);
  });

  it('rejects re-approving an already-resolved request', async () => {
    const r = await submitApproval({ service: 'svc', title: 't' });
    await approveApproval(r.id);
    await expect(approveApproval(r.id)).rejects.toThrow(/already approved/);
  });
});

describe('reject', () => {
  it('runs the on_reject action and marks rejected', async () => {
    fakeFs[`${SVC_JAIL}/d`] = 'c';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_reject: { move: { src: `${SVC_JAIL}/d`, dst: `${SVC_JAIL}/trash/d` } },
    });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    expect(`${SVC_JAIL}/trash/d` in fakeFs).toBe(true);
  });

  it('rejects with no declared action (pure review gate) — unaffected by the jail', async () => {
    const r = await submitApproval({ service: 'svc', title: 't' });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    expect(executor.rename).not.toHaveBeenCalled();
    expect(restartService).not.toHaveBeenCalled();
  });
});

describe('move-jail authorization (#1884)', () => {
  // A jail escape must be refused BEFORE any node side effect — the
  // executor must never see a src/dst outside /mnt/data/stacks/<service>.
  async function expectMoveRejected(move: { src: string; dst: string }, pattern: RegExp) {
    const r = await submitApproval({ service: 'svc', title: 't', on_approve: { move } });
    await expect(approveApproval(r.id)).rejects.toThrow(pattern);
    expect(executor.rename).not.toHaveBeenCalled();
    expect(executor.mkdir).not.toHaveBeenCalled();
    // The request stays pending — nothing happened.
    expect((await getApproval(r.id))?.status).toBe('pending');
  }

  it('rejects a non-absolute src', async () => {
    await expectMoveRejected({ src: 'draft', dst: `${SVC_JAIL}/published` }, /absolute path/);
  });

  it('rejects a non-absolute dst', async () => {
    await expectMoveRejected({ src: `${SVC_JAIL}/draft`, dst: 'published' }, /absolute path/);
  });

  it('rejects a ../ traversal escape on src', async () => {
    await expectMoveRejected(
      { src: `${SVC_JAIL}/../../../etc/passwd`, dst: `${SVC_JAIL}/x` },
      /escapes the service's data jail/,
    );
  });

  it('rejects a dst that resolves into another service jail', async () => {
    await expectMoveRejected(
      { src: `${SVC_JAIL}/secret`, dst: '/mnt/data/stacks/nginx-web/data/secret' },
      /escapes the service's data jail/,
    );
  });

  it('rejects a sibling-prefix dst (svc-evil) that is not under the jail', async () => {
    await expectMoveRejected(
      { src: `${SVC_JAIL}/x`, dst: '/mnt/data/stacks/svc-evil/x' },
      /escapes the service's data jail/,
    );
  });

  it('rejects an absolute system path outside /mnt/data/stacks entirely', async () => {
    await expectMoveRejected(
      { src: `${SVC_JAIL}/x`, dst: '/etc/cron.d/evil' },
      /escapes the service's data jail/,
    );
  });
});

describe('service-name jail anchor (#2043)', () => {
  // A traversal-style `service` would let `serviceJailRoot` collapse the jail
  // anchor outside /mnt/data/stacks/<service> (e.g. '../../../etc' -> '/etc'),
  // so submitApproval must refuse it BEFORE anything is stored.
  async function expectServiceRejected(service: string) {
    await expect(submitApproval({ service, title: 't' })).rejects.toThrow(
      /not a valid service name/,
    );
    // Nothing persisted — the store stays empty.
    expect(await listApprovals()).toEqual([]);
  }

  it('rejects a ../ traversal that would anchor the jail at /etc', async () => {
    await expectServiceRejected('../../../etc');
  });

  it('rejects a name with an embedded path separator', async () => {
    await expectServiceRejected('svc/../../etc');
  });

  it('rejects a bare .. segment', async () => {
    await expectServiceRejected('..');
  });

  it('rejects a leading-slash absolute name', async () => {
    await expectServiceRejected('/etc');
  });

  it('rejects an empty service name', async () => {
    await expectServiceRejected('');
  });

  it('accepts a valid single-segment service name and anchors the jail under it', async () => {
    const SVC = '/mnt/data/stacks/svc';
    fakeFs[`${SVC}/draft`] = 'c';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: `${SVC}/draft`, dst: `${SVC}/done` } },
    });
    expect(r.service).toBe('svc');
    const res = await approveApproval(r.id);
    expect(res.request.status).toBe('approved');
    expect(executor.rename).toHaveBeenCalledWith(`${SVC}/draft`, `${SVC}/done`);
  });
});

describe('restart-target authorization (#1884)', () => {
  it('rejects restarting a load-bearing service (authelia) that is not the requester', async () => {
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { restart: 'authelia' },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/only restart its own service/);
    expect(restartService).not.toHaveBeenCalled();
    expect((await getApproval(r.id))?.status).toBe('pending');
  });

  it('rejects restarting basic/servicebay (arbitrary target)', async () => {
    for (const target of ['basic', 'servicebay']) {
      const r = await submitApproval({
        service: 'svc',
        title: 't',
        on_approve: { restart: target },
      });
      await expect(approveApproval(r.id)).rejects.toThrow(/only restart its own service/);
    }
    expect(restartService).not.toHaveBeenCalled();
  });

  it('rejects an invalid (path-shaped) restart target', async () => {
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { restart: '../../authelia' },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/not a valid service name/);
    expect(restartService).not.toHaveBeenCalled();
  });

  it('allows restarting the requesting service itself', async () => {
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { restart: 'svc' },
    });
    const res = await approveApproval(r.id);
    expect(restartService).toHaveBeenCalledWith('box1', 'svc');
    expect(res.restarted).toBe(true);
  });
});

describe('mcp-tool re-dispatch action (#2234)', () => {
  it('approving an mcp approval re-dispatches the proposed tool and marks approved', async () => {
    const r = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      payload: { toolName: 'delete_service', args: { name: 'media' }, caller: 'token:ci-bot' },
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    const res = await approveApproval(r.id);
    expect(dispatchMcpTool).toHaveBeenCalledWith('delete_service', { name: 'media' });
    expect(res.request.status).toBe('approved');
    expect((await getApproval(r.id))?.status).toBe('approved');
  });

  it('a failed tool dispatch propagates and leaves the request pending', async () => {
    dispatchMcpTool.mockRejectedValueOnce(new Error('tool blew up'));
    const r = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/tool blew up/);
    // The request must NOT be marked approved when the tool failed to run.
    expect((await getApproval(r.id))?.status).toBe('pending');
  });

  it('rejecting an mcp approval cancels it WITHOUT running the tool', async () => {
    const r = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    // on_reject carries no mcp action → the tool is never dispatched.
    expect(dispatchMcpTool).not.toHaveBeenCalled();
  });

  it('the approval persists across a reload of the store (survives restart)', async () => {
    const r = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    // Re-read from disk (fresh listApprovals call = what a restarted process does).
    const reloaded = await getApproval(r.id);
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.on_approve.mcp).toEqual({ toolName: 'delete_service', args: { name: 'media' } });
  });
});

// The store is atomic-written via a temp file + rename. `process.pid` alone is
// a constant (1 in the container), so before #2239 two concurrent writes shared
// ONE temp path — one rename moved it away, the other renamed a now-missing
// temp → ENOENT → the approve handler threw AFTER the tool already ran, and the
// UI hung forever. These fire genuinely-concurrent writes against the REAL fs
// store (only the executor is faked) to prove no ENOENT and no lost update.
describe('concurrent store writes (#2239)', () => {
  it('two concurrent submits both persist — no ENOENT, no lost update', async () => {
    const [a, b] = await Promise.all([
      submitApproval({ service: 'svc-a', title: 'a' }),
      submitApproval({ service: 'svc-b', title: 'b' }),
    ]);
    const list = await listApprovals();
    const ids = list.map(r => r.id);
    // Both requests survive — neither write clobbered the other.
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(list).toHaveLength(2);
  });

  it('a burst of concurrent submits all persist (no writes lost to a temp collision)', async () => {
    const N = 12;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => submitApproval({ service: 'svc', title: `t${i}` })),
    );
    const list = await listApprovals();
    expect(list).toHaveLength(N);
    for (const r of created) {
      expect(list.some(x => x.id === r.id)).toBe(true);
    }
  });

  it('two concurrent approvals both succeed and both leave the pending list', async () => {
    const r1 = await submitApproval({ service: 'svc', title: 'one' });
    const r2 = await submitApproval({ service: 'svc', title: 'two' });
    // Approve both at once — before the fix, one throws ENOENT on rename.
    const results = await Promise.all([approveApproval(r1.id), approveApproval(r2.id)]);
    expect(results.map(x => x.request.status)).toEqual(['approved', 'approved']);
    // Persisted status reflects both approvals — no lost update.
    expect((await getApproval(r1.id))?.status).toBe('approved');
    expect((await getApproval(r2.id))?.status).toBe('approved');
    const stillPending = (await listApprovals()).filter(r => r.status === 'pending');
    expect(stillPending).toHaveLength(0);
  });

  it('concurrent approve of a move + an mcp tool both persist and run their side effects', async () => {
    fakeFs['/mnt/data/stacks/svc/draft'] = 'c';
    const mover = await submitApproval({
      service: 'svc',
      title: 'promote',
      on_approve: { move: { src: '/mnt/data/stacks/svc/draft', dst: '/mnt/data/stacks/svc/published' } },
    });
    const runner = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    const [mv, mc] = await Promise.all([approveApproval(mover.id), approveApproval(runner.id)]);
    expect(mv.request.status).toBe('approved');
    expect(mc.request.status).toBe('approved');
    expect('/mnt/data/stacks/svc/published' in fakeFs).toBe(true);
    expect(dispatchMcpTool).toHaveBeenCalledWith('delete_service', { name: 'media' });
  });

  it('a persist failure AFTER the tool ran surfaces a clear "ran but not saved" error (client not stranded)', async () => {
    const r = await submitApproval({
      service: 'media',
      title: 'delete_service: media',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    });
    // The destructive tool runs, THEN the final store write fails — the handler
    // must reject with a distinct message (not a raw ENOENT) so the UI leaves
    // its loading state and the operator learns the tool already ran.
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(approveApproval(r.id)).rejects.toThrow(/approved and executed, but saving the result failed/);
    // The tool DID run — the error is about persistence, not the action.
    expect(dispatchMcpTool).toHaveBeenCalledWith('delete_service', { name: 'media' });
    renameSpy.mockRestore();
  });
});

describe('isSelfApproval — token cannot resolve its own proposal (#2244)', () => {
  const withCaller = (caller: unknown): ApprovalRequest => ({
    id: 'r1',
    service: 'media',
    title: 'delete_service: media',
    description: null,
    payload: caller === undefined ? {} : { caller },
    on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    on_reject: {},
    node: 'box1',
    created_at: new Date().toISOString(),
    status: 'pending',
  });

  it('blocks the SAME token that proposed the request', () => {
    expect(isSelfApproval(withCaller('token:solaris'), 'token:solaris')).toBe(true);
  });

  it('allows a DIFFERENT token to resolve it (verdict-delivery consumer)', () => {
    expect(isSelfApproval(withCaller('token:solaris'), 'token:other')).toBe(false);
  });

  it('never blocks the cookie operator (non-token caller)', () => {
    expect(isSelfApproval(withCaller('token:solaris'), 'admin')).toBe(false);
    expect(isSelfApproval(withCaller('token:solaris'), 'internal')).toBe(false);
    expect(isSelfApproval(withCaller('token:solaris'), undefined)).toBe(false);
  });

  it('is a no-op for a request with no recorded proposer (plain move/restart)', () => {
    expect(isSelfApproval(withCaller(undefined), 'token:solaris')).toBe(false);
  });
});

// #2268 part B — the new-approval event hook. Solaris subscribes server-server
// and republishes on its own bus; the SSE route (wiring tested separately) is a
// thin adapter over this emit. Here we prove the emit fires on a new pending
// approval, carries a MINIMAL secret-free payload, and unsubscribe stops it.
describe('onNewApproval / submitApproval emit hook (#2268 part B)', () => {
  it('emits a new-approval event with id/kind/summary when a request is created', async () => {
    const events: NewApprovalEvent[] = [];
    const off = onNewApproval(e => events.push(e));
    try {
      const created = await submitApproval({
        service: 'media',
        title: 'delete_service: media',
        description: 'secret detail here',
        payload: { caller: 'token:solaris', secretToken: 'sb_should_not_leak' },
        on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
        node: 'box1',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'new-approval',
        id: created.id,
        kind: 'media',
        summary: 'delete_service: media',
        created_at: created.created_at,
      });
    } finally {
      off();
    }
  });

  it('leaks NO secret/payload/action fields onto the event', async () => {
    const events: NewApprovalEvent[] = [];
    const off = onNewApproval(e => events.push(e));
    try {
      await submitApproval({
        service: 'media',
        title: 'do the thing',
        payload: { caller: 'token:solaris', apiKey: 'sb_secret_value' },
        on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
        node: 'box1',
      });
      const serialized = JSON.stringify(events[0]);
      expect(serialized).not.toContain('sb_secret_value');
      expect(serialized).not.toContain('delete_service');
      expect(Object.keys(events[0]).sort()).toEqual(['created_at', 'id', 'kind', 'summary', 'type']);
    } finally {
      off();
    }
  });

  it('stops delivering after unsubscribe', async () => {
    const events: NewApprovalEvent[] = [];
    const off = onNewApproval(e => events.push(e));
    off();
    await submitApproval({ service: 'media', title: 't', node: 'box1' });
    expect(events).toHaveLength(0);
  });

  it('a throwing listener does not fail the submit (approval is stored)', async () => {
    const off = onNewApproval(() => { throw new Error('boom'); });
    try {
      const created = await submitApproval({ service: 'media', title: 't', node: 'box1' });
      expect(await getApproval(created.id)).not.toBeNull();
    } finally {
      off();
    }
  });
});
