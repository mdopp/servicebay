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
      service: 'honcho',
      title: 'delete_service: honcho',
      payload: { toolName: 'delete_service', args: { name: 'honcho' }, caller: 'token:ci-bot' },
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    const res = await approveApproval(r.id);
    expect(dispatchMcpTool).toHaveBeenCalledWith('delete_service', { name: 'honcho' });
    expect(res.request.status).toBe('approved');
    expect((await getApproval(r.id))?.status).toBe('approved');
  });

  it('a failed tool dispatch propagates and leaves the request pending', async () => {
    dispatchMcpTool.mockRejectedValueOnce(new Error('tool blew up'));
    const r = await submitApproval({
      service: 'honcho',
      title: 'delete_service: honcho',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/tool blew up/);
    // The request must NOT be marked approved when the tool failed to run.
    expect((await getApproval(r.id))?.status).toBe('pending');
  });

  it('rejecting an mcp approval cancels it WITHOUT running the tool', async () => {
    const r = await submitApproval({
      service: 'honcho',
      title: 'delete_service: honcho',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    // on_reject carries no mcp action → the tool is never dispatched.
    expect(dispatchMcpTool).not.toHaveBeenCalled();
  });

  it('the approval persists across a reload of the store (survives restart)', async () => {
    const r = await submitApproval({
      service: 'honcho',
      title: 'delete_service: honcho',
      on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
    });
    // Re-read from disk (fresh listApprovals call = what a restarted process does).
    const reloaded = await getApproval(r.id);
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.on_approve.mcp).toEqual({ toolName: 'delete_service', args: { name: 'honcho' } });
  });
});
