import { describe, it, expect, beforeEach, vi } from 'vitest';

// Approval gate (#1766, #2234): a TOKEN-authenticated MCP caller can PROPOSE a
// destroy-tier tool but cannot execute it — the call parks as a *durable*
// approval in the shared approvals queue (lib/approvals), which the operator's
// Approvals UI surfaces. A COOKIE caller (no token auth ⇒ `auth` undefined)
// executes inline as before. Tested at the server/safeHandler seam with the
// approvals store and underlying mutation mocked.

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

// The persistent approvals store — capture what the gate submits.
const submitApproval = vi.fn((input: Record<string, unknown>) => Promise.resolve({ id: 'appr-1', ...input }));
vi.mock('@/lib/approvals', () => ({
  submitApproval: (input: Record<string, unknown>) => submitApproval(input),
  // server.ts registers the MCP dispatcher at module load — no-op here.
  registerMcpDispatcher: vi.fn(),
  // tokenRequests.ts (imported transitively) registers the one-shot minter at
  // module load (#2245) — no-op here.
  registerTokenMinter: vi.fn(),
}));

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

describe('MCP destructive approval gate (#1766, #2234)', () => {
  beforeEach(() => {
    submitApproval.mockClear();
    deleteService.mockClear();
  });

  it('a token caller PROPOSES a destroy-tier tool — it parks as a durable approval, does not execute', async () => {
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    const res = await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    const text = (res.content as { text: string }[])[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.status).toBe('pending_approval');
    expect(parsed.approvalId).toBe('appr-1');
    expect(parsed.toolName).toBe('delete_service');
    // The real mutation must NOT have run.
    expect(deleteService).not.toHaveBeenCalled();
    // It was submitted to the durable approvals queue, carrying the tool
    // re-dispatch action and a service anchor derived from args.name.
    expect(submitApproval).toHaveBeenCalledTimes(1);
    const submitted = submitApproval.mock.calls[0][0] as {
      service: string;
      payload: Record<string, unknown>;
      on_approve: { mcp: { toolName: string; args: Record<string, unknown> } };
    };
    expect(submitted.service).toBe('immich');
    expect(submitted.on_approve.mcp).toEqual({ toolName: 'delete_service', args: { name: 'immich' } });
    expect(submitted.payload).toMatchObject({ toolName: 'delete_service', caller: 'token:ci-bot' });
    await client.close();
  });

  it('falls back to the "mcp" service anchor when the tool names no service', async () => {
    // set_boot_next_usb is destroy-tier with all-optional args (no name/service).
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    const res = await client.callTool({ name: 'set_boot_next_usb', arguments: { action: 'list' } });
    const parsed = JSON.parse((res.content as { text: string }[])[0].text);
    expect(parsed.status).toBe('pending_approval');
    const submitted = submitApproval.mock.calls[0][0] as { service: string; title: string };
    expect(submitted.service).toBe('mcp');
    // No "service" suffix on the title when the anchor is the neutral bucket.
    expect(submitted.title).toBe('set_boot_next_usb');
    await client.close();
  });

  it('a COOKIE caller (no token auth) executes a destroy-tier tool inline — no gate, no approval', async () => {
    // No `auth` ⇒ cookie path. The mutation runs immediately, nothing parks.
    const { client } = await connect();
    await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    expect(deleteService).toHaveBeenCalledTimes(1);
    expect(submitApproval).not.toHaveBeenCalled();
    await client.close();
  });

  it('a non-destroy tool from a token caller is NOT gated (e.g. read-tier)', async () => {
    const { client } = await connect({ auth: { ...TOKEN_AUTH, scopes: [...TOKEN_AUTH.scopes] } });
    const res = await client.callTool({ name: 'list_trashed_services', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(submitApproval).not.toHaveBeenCalled();
    await client.close();
  });
});
