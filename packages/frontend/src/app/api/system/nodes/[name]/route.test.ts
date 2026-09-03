/**
 * PATCH / DELETE /api/system/nodes/:name.
 *
 * Carried forward from `app/actions/nodes.test.ts` (#2745): the edit path
 * must apply the same SSH-identity path-injection barrier as create, and
 * delete must take the node's health checks with it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/sb-node-item-route-test-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = dir;
  return dir;
});

const SSH_ROOT = path.join(DATA_DIR, 'ssh');
const LEGIT_KEY = path.join(SSH_ROOT, 'id_rsa');
fs.mkdirSync(SSH_ROOT, { recursive: true });
fs.writeFileSync(LEGIT_KEY, 'x');

const mocks = vi.hoisted(() => ({
  updateNode: vi.fn(),
  removeNode: vi.fn(),
  verifyNodeConnection: vi.fn(async (_name: string) => ({ success: true })),
  getChecks: vi.fn(() => [] as { id: string; name: string; nodeName?: string }[]),
  deleteCheck: vi.fn(),
}));

vi.mock('@/lib/nodes', () => ({
  updateNode: mocks.updateNode,
  removeNode: mocks.removeNode,
}));
vi.mock('@/lib/nodes/verify', () => ({ verifyNodeConnection: mocks.verifyNodeConnection }));
vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: mocks.getChecks, deleteCheck: mocks.deleteCheck },
}));
vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (_opts: unknown, handler: (input: { body: unknown; params: unknown }) => Promise<unknown>) =>
    (body: unknown, params: unknown) =>
      handler({ body, params }),
}));

import { PATCH, DELETE } from './route';

type Result = { success: boolean; error?: string; warning?: string };
const patch = (identity: string, oldName = 'old') =>
  (PATCH as unknown as (b: unknown, p: unknown) => Promise<Result>)(
    { name: 'new', destination: 'ssh://user@host', identity },
    { name: oldName },
  );
const del = (name: string) =>
  (DELETE as unknown as (b: unknown, p: unknown) => Promise<Result>)(undefined, { name });

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('PATCH /api/system/nodes/:name', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a legit key and stores the resolved identity', async () => {
    const res = await patch(LEGIT_KEY);
    expect(res.success).toBe(true);
    expect(mocks.updateNode).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({ Identity: LEGIT_KEY }),
    );
  });

  it('rejects a traversal identity and never touches updateNode', async () => {
    const res = await patch(`${SSH_ROOT}/../../etc/passwd`);
    expect(res.success).toBe(false);
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/system/nodes/:name', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops the node and every health check that pointed at it', async () => {
    mocks.getChecks.mockReturnValueOnce([
      { id: 'a', name: 'Node Health: box' },
      { id: 'b', name: 'Agent: box' },
      { id: 'c', name: 'something else', nodeName: 'box' },
      { id: 'd', name: 'unrelated', nodeName: 'other' },
    ]);

    const res = await del('box');

    expect(res.success).toBe(true);
    expect(mocks.removeNode).toHaveBeenCalledWith('box');
    expect(mocks.deleteCheck.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c']);
  });
});
