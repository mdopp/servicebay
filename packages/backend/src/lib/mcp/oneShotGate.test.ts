import { describe, it, expect, beforeEach, vi } from 'vitest';

// One-shot elevated-token gate (#2245, option b): a token minted through the
// approved request_token one-shot flow holds an elevated scope BOUND to exactly
// one op. The MCP gate must:
//   - run the bound op inline WITHOUT re-parking (it was already owner-approved),
//   - burn the single-use token after the op succeeds,
//   - refuse any OTHER tool the token tries, and
//   - refuse the bound tool against a DIFFERENT service.
// Tested at the server/safeHandler seam with the mutation + burn mocked.

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn().mockResolvedValue({ mcp: { allowMutations: true } }),
  updateConfig: vi.fn(),
}));
vi.mock('./safety', async (orig) => {
  const actual = await orig<typeof import('./safety')>();
  return { ...actual, snapshotBeforeMutation: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('./audit', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./notify', () => ({ notifyDestructiveOp: vi.fn().mockResolvedValue(undefined) }));

// The gate must NOT park a one-shot token — assert submitApproval is never hit.
const submitApproval = vi.fn((_input: Record<string, unknown>) => Promise.resolve({ id: 'appr-x' }));
vi.mock('@/lib/approvals', () => ({
  submitApproval: (input: Record<string, unknown>) => submitApproval(input),
  registerMcpDispatcher: vi.fn(),
  registerTokenMinter: vi.fn(),
}));

// Capture the single-use burn.
const consumeSingleUseToken = vi.fn((_id: string) => Promise.resolve(true));
vi.mock('@/lib/auth/apiTokens', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/apiTokens')>();
  return { ...actual, consumeSingleUseToken: (id: string) => consumeSingleUseToken(id) };
});

const deleteService = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    deleteService: (...a: unknown[]) => deleteService(...a),
    listTrashedServices: vi.fn().mockResolvedValue([]),
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

// A one-shot token: elevated destroy scope, bound to delete_service on media.
const ONE_SHOT_AUTH = {
  user: 'token:mcp-oneshot',
  scopes: ['destroy'] as const,
  tokenId: 'ost1',
  oneShotOp: { toolName: 'delete_service', service: 'media' },
  singleUse: true,
};

describe('one-shot elevated token gate (#2245)', () => {
  beforeEach(() => {
    submitApproval.mockClear();
    deleteService.mockClear();
    consumeSingleUseToken.mockClear();
    consumeSingleUseToken.mockResolvedValue(true);
  });

  it('runs the bound op inline (no re-parking) and BURNS the token after it succeeds', async () => {
    const { client } = await connect({ auth: { ...ONE_SHOT_AUTH, scopes: [...ONE_SHOT_AUTH.scopes] } });
    const res = await client.callTool({ name: 'delete_service', arguments: { name: 'media' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    // The destructive op ran once, inline — it did NOT park for approval.
    expect(deleteService).toHaveBeenCalledTimes(1);
    expect(submitApproval).not.toHaveBeenCalled();
    // The single-use token was burned with its id.
    expect(consumeSingleUseToken).toHaveBeenCalledWith('ost1');
    await client.close();
  });

  it('refuses ANY other tool the one-shot token was not minted for — and does not burn', async () => {
    const { client } = await connect({ auth: { ...ONE_SHOT_AUTH, scopes: [...ONE_SHOT_AUTH.scopes] } });
    const res = await client.callTool({ name: 'list_trashed_services', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/one-shot token bound to "delete_service"/);
    expect(deleteService).not.toHaveBeenCalled();
    expect(consumeSingleUseToken).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses the bound tool against a DIFFERENT service (grant cannot be redirected)', async () => {
    const { client } = await connect({ auth: { ...ONE_SHOT_AUTH, scopes: [...ONE_SHOT_AUTH.scopes] } });
    const res = await client.callTool({ name: 'delete_service', arguments: { name: 'immich' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/bound to "delete_service" on "media"/);
    expect(deleteService).not.toHaveBeenCalled();
    expect(consumeSingleUseToken).not.toHaveBeenCalled();
    await client.close();
  });

  it('does NOT burn when the bound op reports a logical error (caller can retry within TTL)', async () => {
    deleteService.mockRejectedValueOnce(new Error('boom'));
    const { client } = await connect({ auth: { ...ONE_SHOT_AUTH, scopes: [...ONE_SHOT_AUTH.scopes] } });
    const res = await client.callTool({ name: 'delete_service', arguments: { name: 'media' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(consumeSingleUseToken).not.toHaveBeenCalled();
    await client.close();
  });
});
