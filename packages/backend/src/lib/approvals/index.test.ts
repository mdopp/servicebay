/* eslint-disable @typescript-eslint/no-explicit-any */
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
} from './index';

beforeEach(() => {
  for (const k of Object.keys(fakeFs)) delete fakeFs[k];
  executor.exists.mockClear();
  executor.rename.mockClear();
  executor.mkdir.mockClear();
  restartService.mockClear();
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

describe('approve', () => {
  it('runs the declared move action and marks approved', async () => {
    fakeFs['/src/draft'] = 'content';
    const r = await submitApproval({
      service: 'svc',
      title: 'promote',
      on_approve: { move: { src: '/src/draft', dst: '/dst/draft' } },
    });
    const res = await approveApproval(r.id);
    expect(res.request.status).toBe('approved');
    expect(executor.rename).toHaveBeenCalledWith('/src/draft', '/dst/draft');
    expect('/dst/draft' in fakeFs).toBe(true);
    expect((await getApproval(r.id))?.status).toBe('approved');
  });

  it('restarts the declared service after the move', async () => {
    fakeFs['/src/x'] = 'c';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: '/src/x', dst: '/dst/x' }, restart: 'my-service' },
    });
    const res = await approveApproval(r.id);
    expect(restartService).toHaveBeenCalledWith('box1', 'my-service');
    expect(res.restarted).toBe(true);
  });

  it('surfaces a restart failure as a soft warning without rolling back the move', async () => {
    fakeFs['/src/y'] = 'c';
    restartService.mockRejectedValueOnce(new Error('boom'));
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: '/src/y', dst: '/dst/y' }, restart: 'svc2' },
    });
    const res = await approveApproval(r.id);
    expect(res.restarted).toBe(false);
    expect(res.restartError).toBe('boom');
    expect('/dst/y' in fakeFs).toBe(true);
    expect(res.request.status).toBe('approved');
  });

  it('throws when the source path is missing', async () => {
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: '/nope', dst: '/dst' } },
    });
    await expect(approveApproval(r.id)).rejects.toThrow(/not found/);
    expect((await getApproval(r.id))?.status).toBe('pending');
  });

  it('throws when the destination already exists', async () => {
    fakeFs['/src/z'] = 'c';
    fakeFs['/dst/z'] = 'old';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_approve: { move: { src: '/src/z', dst: '/dst/z' } },
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
    fakeFs['/src/d'] = 'c';
    const r = await submitApproval({
      service: 'svc',
      title: 't',
      on_reject: { move: { src: '/src/d', dst: '/trash/d' } },
    });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    expect('/trash/d' in fakeFs).toBe(true);
  });

  it('rejects with no declared action (pure review gate)', async () => {
    const r = await submitApproval({ service: 'svc', title: 't' });
    const res = await rejectApproval(r.id);
    expect(res.request.status).toBe('rejected');
    expect(executor.rename).not.toHaveBeenCalled();
  });
});
