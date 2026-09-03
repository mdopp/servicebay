/**
 * POST /api/system/nodes — SSH-identity path-injection barrier.
 *
 * Carried forward from `app/actions/nodes.test.ts` when the node server
 * actions became routes (#2745). The barrier (`lib/nodes/identityPath.ts`)
 * is the CodeQL js/path-injection sanitizer: a request-supplied `identity`
 * must resolve inside the managed SSH dir or `~/.ssh`, or the request is
 * rejected before anything touches `fs` or the node store.
 *
 * The wrapper is stubbed so the handler body is exercised directly; the
 * session gate itself is covered by requireSession.test.ts and by
 * `../sessionGuards.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Point the real @/lib/dirs SSH_DIR (= DATA_DIR/ssh) at a temp tree by setting
// DATA_DIR before the module graph loads. vi.hoisted runs before the hoisted
// static imports, and only touches process.env, so no import is needed here.
const DATA_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/sb-nodes-route-test-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = dir;
  return dir;
});

const SSH_ROOT = path.join(DATA_DIR, 'ssh');
const LEGIT_KEY = path.join(SSH_ROOT, 'id_rsa');
fs.mkdirSync(SSH_ROOT, { recursive: true });
fs.writeFileSync(LEGIT_KEY, 'x');

const mocks = vi.hoisted(() => ({
  addNode: vi.fn(),
  verifyNodeConnection: vi.fn(async (_name: string) => ({ success: true })),
  saveCheck: vi.fn(),
}));

vi.mock('@/lib/nodes', () => ({
  addNode: mocks.addNode,
  listNodes: vi.fn(async () => []),
}));
vi.mock('@/lib/nodes/verify', () => ({ verifyNodeConnection: mocks.verifyNodeConnection }));
vi.mock('@/lib/health/store', () => ({ HealthStore: { saveCheck: mocks.saveCheck } }));
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (_opts: unknown, handler: (input: { body: unknown }) => Promise<unknown>) =>
    (body: unknown) =>
      handler({ body }),
}));

import { POST } from './route';

type Result = { success: boolean; error?: string; warning?: string };
const post = (identity: string, name = 'n1') =>
  (POST as unknown as (b: unknown) => Promise<Result>)({
    name,
    destination: 'ssh://user@host',
    identity,
  });

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('POST /api/system/nodes — SSH-identity path-injection barrier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a key under the managed SSH dir and stores the resolved path', async () => {
    const res = await post(LEGIT_KEY);
    expect(res.success).toBe(true);
    expect(mocks.addNode).toHaveBeenCalledWith('n1', 'ssh://user@host', LEGIT_KEY);
  });

  it.each([
    ['absolute path outside the allowed dirs', '/etc/passwd'],
    ['traversal escaping the managed dir', `${SSH_ROOT}/../../../../etc/shadow`],
    ['tilde-relative traversal', '~/../../etc/passwd'],
    ['NUL byte', `${LEGIT_KEY}\0`],
    ['empty string', ''],
  ])('rejects %s and never touches addNode', async (_label, identity) => {
    const res = await post(identity, 'n2');
    expect(res.success).toBe(false);
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('reports a warning instead of health checks when the connection probe fails', async () => {
    mocks.verifyNodeConnection.mockResolvedValueOnce({ success: false, error: 'publickey' } as never);
    const res = await post(LEGIT_KEY);
    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/publickey/);
    expect(mocks.saveCheck).not.toHaveBeenCalled();
  });

  it('registers the node + agent health checks once the node verifies', async () => {
    await post(LEGIT_KEY);
    expect(mocks.saveCheck).toHaveBeenCalledTimes(2);
  });
});
