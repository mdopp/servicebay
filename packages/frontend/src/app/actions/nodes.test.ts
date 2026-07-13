import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Point the real @/lib/dirs SSH_DIR (= DATA_DIR/ssh) at a temp tree by setting
// DATA_DIR before the module graph loads. vi.hoisted runs before the hoisted
// static imports, and only touches process.env, so no import is needed here.
const DATA_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/sb-nodes-test-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = dir;
  return dir;
});

const SSH_ROOT = path.join(DATA_DIR, 'ssh');
const LEGIT_KEY = path.join(SSH_ROOT, 'id_rsa');
fs.mkdirSync(SSH_ROOT, { recursive: true });
fs.writeFileSync(LEGIT_KEY, 'x');

const mockAddNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockVerify = vi.fn(async (_name: string) => ({ success: true }));

vi.mock('@/lib/nodes', () => ({
  addNode: (name: string, dest: string, id?: string) => mockAddNode(name, dest, id),
  updateNode: (oldName: string, node: unknown) => mockUpdateNode(oldName, node),
  listNodes: vi.fn(),
  removeNode: vi.fn(),
  setDefaultNode: vi.fn(),
}));
vi.mock('@/lib/nodes/verify', () => ({ verifyNodeConnection: (name: string) => mockVerify(name) }));
vi.mock('@/lib/health/store', () => ({ HealthStore: { saveCheck: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('./_session', () => ({ assertAdminSession: vi.fn(async () => {}) }));

import { createNode, editNode } from './nodes';

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('nodes action — SSH-identity path-injection barrier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createNode accepts a key under the managed SSH dir and stores the resolved path', async () => {
    const res = await createNode('n1', 'ssh://user@host', LEGIT_KEY);
    expect(res.success).toBe(true);
    expect(mockAddNode).toHaveBeenCalledWith('n1', 'ssh://user@host', LEGIT_KEY);
  });

  it.each([
    ['absolute path outside the allowed dirs', '/etc/passwd'],
    ['traversal escaping the managed dir', `${SSH_ROOT}/../../../../etc/shadow`],
    ['tilde-relative traversal', '~/../../etc/passwd'],
    ['NUL byte', `${LEGIT_KEY}\0`],
    ['empty string', ''],
  ])('createNode rejects %s and never touches addNode', async (_label, identity) => {
    const res = await createNode('n2', 'ssh://user@host', identity);
    expect(res.success).toBe(false);
    expect(mockAddNode).not.toHaveBeenCalled();
  });

  it('editNode accepts a legit key and stores the resolved identity', async () => {
    const res = await editNode('old', 'new', 'ssh://user@host', LEGIT_KEY);
    expect(res.success).toBe(true);
    expect(mockUpdateNode).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({ Identity: LEGIT_KEY }),
    );
  });

  it('editNode rejects a traversal identity and never touches updateNode', async () => {
    const res = await editNode('old', 'new', 'ssh://user@host', `${SSH_ROOT}/../../etc/passwd`);
    expect(res.success).toBe(false);
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });
});
