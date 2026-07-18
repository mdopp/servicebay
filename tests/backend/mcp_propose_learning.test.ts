import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// End-to-end MCP path for propose_learning (#2326 slice 1): a propose-scoped
// token submits an assist proposal through the server tool and it lands as a
// PENDING record in the store; a token without `propose` is refused.

// Holder is created via vi.hoisted so it exists before the (hoisted) vi.mock
// factory and any module-load read of DATA_DIR (e.g. registry.ts) runs.
const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-propose-mcp-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

// Keep the safety/audit layer inert (same shape as server.toolVisibility.test).
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn().mockResolvedValue({ mcp: { allowMutations: true } }),
  updateConfig: vi.fn(),
}));
vi.mock('@/lib/mcp/safety', async (orig) => {
  const actual = await orig<typeof import('@/lib/mcp/safety')>();
  return { ...actual, snapshotBeforeMutation: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/mcp/audit', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/mcp/notify', () => ({ notifyDestructiveOp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/approvals', () => ({
  submitApproval: vi.fn().mockResolvedValue({ id: 'appr-1' }),
  registerMcpDispatcher: vi.fn(),
  registerTokenMinter: vi.fn(),
}));
vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn().mockResolvedValue([{ Name: 'Local' }]),
  getNodeConnection: vi.fn(),
}));

import { createMcpServer } from '@/lib/mcp/server';
import { listProposals } from '@/lib/assists/proposals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function connect(opts?: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client };
}

const VALID = {
  title: 'A brand new companion recipe',
  whenToUse: 'When you want a runtime-only companion.',
  kind: 'recipe',
  tags: ['x'],
  body: '# body\n',
};

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-propose-mcp-'));
  vi.clearAllMocks();
});
afterEach(async () => {
  await fs.rm(dirState.dir, { recursive: true, force: true });
});

describe('propose_learning MCP tool (#2326)', () => {
  it('a propose-scoped token submits and receives a pending proposal id', async () => {
    const { client } = await connect({ auth: { user: 'token:proposer', scopes: ['propose'] } });
    const res = await client.callTool({ name: 'propose_learning', arguments: VALID });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse((res.content as { text: string }[])[0].text);
    expect(out.ok).toBe(true);
    expect(out.status).toBe('pending');
    expect(out.id).toBeTruthy();
    expect(out.assistId).toBe('local/a-brand-new-companion-recipe');

    const stored = await listProposals();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('pending');
    expect(stored[0].submittedBy).toBe('token:proposer');
  });

  it('rejects an invalid kind through the tool (schema validation)', async () => {
    const { client } = await connect({ auth: { user: 'token:proposer', scopes: ['propose'] } });
    const res = await client.callTool({
      name: 'propose_learning',
      arguments: { ...VALID, kind: 'nonsense' },
    });
    expect(res.isError).toBe(true);
    expect(await listProposals()).toHaveLength(0);
  });

  it('a token without propose scope is refused (no persistence)', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: ['read'] } });
    const res = await client.callTool({ name: 'propose_learning', arguments: VALID });
    expect(res.isError).toBe(true);
    const text = (res.content as { text?: string }[])[0]?.text ?? '';
    expect(text).toMatch(/scope 'propose' required/i);
    expect(await listProposals()).toHaveLength(0);
  });
});
