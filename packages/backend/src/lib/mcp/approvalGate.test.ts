import { describe, it, expect, beforeEach, vi } from 'vitest';

// Approval gate (#1766): a TOKEN-authenticated MCP caller can PROPOSE a
// destroy-tier tool but cannot execute it — the call parks for a human
// confirm. A COOKIE caller (no token auth ⇒ `auth` undefined) executes
// inline as before. The confirm route runs the stored call. Tested at the
// server/safeHandler seam with the underlying mutation + side-effects mocked.

// guardMutation reads config.mcp.allowMutations — allow it.
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn().mockResolvedValue({ mcp: { allowMutations: true } }),
  updateConfig: vi.fn(),
}));
// Pre-mutation snapshot — make it a cheap no-op so the test doesn't try to back up.
vi.mock('./safety', async (orig) => {
  const actual = await orig<typeof import('./safety')>();
  return { ...actual, snapshotBeforeMutation: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('./audit', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./notify', () => ({ notifyDestructiveOp: vi.fn().mockResolvedValue(undefined) }));

const deleteService = vi.fn().mockResolvedValue(undefined);
const listTrashedServices = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    deleteService: (...a: unknown[]) => deleteService(...a),
    listTrashedServices: (...a: unknown[]) => listTrashedServices(...a),
  },
}));
vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn().mockResolvedValue([{ Name: 'Local' }]),
  getNodeConnection: vi.fn(),
}));

import { createMcpServer } from './server';
import {
  listPendingApprovals,
  approvePendingApproval,
  __clearPendingApprovalsForTest,
} from './pendingApprovals';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function connect(opts?: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

const TOKEN_AUTH = { user: 'token:ci-bot', scopes: ['read', 'lifecycle', 'mutate', 'destroy'] as const, tokenId: 't1' };

describe('MCP destructive approval gate (#1766)', () => {
  beforeEach(() => {
    __clearPendingApprovalsForTest();
    deleteService.mockClear();
  });

  it('a token caller PROPOSES a destroy-tier tool — it parks, does not execute', async () => {
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    const res = await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    const text = (res.content as { text: string }[])[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.status).toBe('pending_approval');
    expect(parsed.pendingId).toBeTruthy();
    expect(parsed.toolName).toBe('delete_service');
    // The real mutation must NOT have run.
    expect(deleteService).not.toHaveBeenCalled();
    // It is now listed as pending.
    const pending = listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].caller).toBe('token:ci-bot');
    await client.close();
  });

  it('approving the parked call executes the stored mutation', async () => {
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    const [pending] = listPendingApprovals();

    expect(deleteService).not.toHaveBeenCalled();
    await approvePendingApproval(pending.pendingId);
    // Now the real mutation has run, with the original args.
    expect(deleteService).toHaveBeenCalledTimes(1);
    expect(deleteService).toHaveBeenCalledWith('Local', 'immich');
    // Single-use: gone from the list.
    expect(listPendingApprovals()).toHaveLength(0);
    await client.close();
  });

  it('a COOKIE caller (no token auth) executes a destroy-tier tool inline — no gate', async () => {
    // No `auth` ⇒ cookie path. The mutation runs immediately, nothing parks.
    const { client } = await connect();
    await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    expect(deleteService).toHaveBeenCalledTimes(1);
    expect(listPendingApprovals()).toHaveLength(0);
    await client.close();
  });

  it('a non-destroy tool from a token caller is NOT gated (e.g. mutate-tier)', async () => {
    // restart_service is lifecycle-tier — should pass straight through, not park.
    // (delete is the destroy-tier case above; here we assert the gate is scoped.)
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    // Use a tool we can observe didn't park: list_trashed_services is read-tier.
    const res = await client.callTool({ name: 'list_trashed_services', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(listPendingApprovals()).toHaveLength(0);
    await client.close();
  });
});
