import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #2653 (split from #2651): `get_approval_status` — the read side of the
// destroy-tier approval gate.
//
// The reported defect was that an `approvalId` resolved NOWHERE: the caller got
// one back from a destroy-tier tool, tried `get_access_request_status` (the only
// documented poll verb) and `list_requests`, and both answered from other
// stores. So these tests run the REAL `lib/approvals` store against a temp
// DATA_DIR and poll it through the REAL MCP surface — a test that mocked the
// store would prove the tool returns what the mock says, not that the two
// halves are actually wired to the same file.

const { TMP } = vi.hoisted(() => ({
  TMP: `${process.env.TMPDIR || '/tmp'}/approval-status-test-${process.pid}`,
}));
vi.mock('@/lib/dirs', () => ({ DATA_DIR: TMP }));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn().mockResolvedValue({ mcp: { allowMutations: true }, accessRequests: [] }),
  updateConfig: vi.fn(),
}));
vi.mock('./safety', async (orig) => {
  const actual = await orig<typeof import('./safety')>();
  return { ...actual, snapshotBeforeMutation: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('./audit', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./notify', () => ({ notifyDestructiveOp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/executor', () => ({ getExecutor: vi.fn() }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { restartService: vi.fn() } }));
vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn().mockResolvedValue([{ Name: 'box1' }]),
  getNodeConnection: vi.fn(),
}));

import {
  submitApproval,
  approveApproval,
  rejectApproval,
  registerMcpDispatcher,
} from '@/lib/approvals';
import { createMcpServer } from './server';
import { APPROVAL_STATUS_TOOL } from './toolPolicy';

// Take the dispatcher back off server.ts (which registers a real one at module
// load) so approving an MCP approval doesn't try to delete anything.
const dispatchMcpTool = vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }));
registerMcpDispatcher(dispatchMcpTool);

async function connect(opts?: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

/** Poll one approvalId through the MCP surface, as an agent would. */
async function poll(approvalId: string) {
  const { client } = await connect();
  try {
    return parse(await client.callTool({
      name: APPROVAL_STATUS_TOOL,
      arguments: { approval_id: approvalId },
    }));
  } finally {
    await client.close();
  }
}

/** A destroy-tier proposal in the exact shape server.ts's gate parks. */
function proposeDestroyTierTool(toolName = 'remove_proxy_route', args: Record<string, unknown> = { domain: 'dangling.example.com' }) {
  return submitApproval({
    service: 'mcp',
    title: toolName,
    payload: { toolName, args, caller: 'token:ci-bot' },
    on_approve: { mcp: { toolName, args } },
  });
}

beforeEach(() => {
  dispatchMcpTool.mockClear();
  dispatchMcpTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('get_approval_status — a destroy-tier approvalId resolves (#2653)', () => {
  it('an unknown id answers not-found rather than throwing', async () => {
    expect(await poll('no-such-approval')).toMatchObject({ status: 'not-found' });
  });

  it('a freshly parked proposal reads pending, and names the proposed tool', async () => {
    const request = await proposeDestroyTierTool();
    expect(await poll(request.id)).toMatchObject({
      approvalId: request.id,
      status: 'pending',
      toolName: 'remove_proxy_route',
      service: 'mcp',
    });
  });

  it('an approved proposal whose tool RAN reads approved-executed', async () => {
    const request = await proposeDestroyTierTool();
    await approveApproval(request.id);
    expect(dispatchMcpTool).toHaveBeenCalledWith('remove_proxy_route', { domain: 'dangling.example.com' });
    const polled = await poll(request.id);
    expect(polled.status).toBe('approved-executed');
    expect(polled.resolvedAt).toEqual(expect.any(String));
    expect(polled.error).toBeUndefined();
  });

  // The outcome the whole unit exists for: the operator DID decide, and the
  // action then failed. Before #2653 the record was byte-identical to "no
  // decision yet", so the caller polled `pending` forever.
  it('an approved proposal whose tool FAILED reads approved-failed, not pending', async () => {
    dispatchMcpTool.mockRejectedValueOnce(new Error('NPM host 502'));
    const request = await proposeDestroyTierTool();
    await expect(approveApproval(request.id)).rejects.toThrow(/NPM host 502/);
    const polled = await poll(request.id);
    expect(polled.status).toBe('approved-failed');
    expect(polled.error).toMatch(/NPM host 502/);
    // Honest about the queue state: it was NOT removed, so it can be retried.
    expect(polled.stillPending).toBe(true);
    expect(polled.failedAt).toEqual(expect.any(String));
  });

  it('a rejected proposal reads rejected and its tool never ran', async () => {
    const request = await proposeDestroyTierTool();
    await rejectApproval(request.id);
    expect(dispatchMcpTool).not.toHaveBeenCalled();
    expect(await poll(request.id)).toMatchObject({ status: 'rejected' });
  });

  it('a one-shot request_token approval resolves too, and points at poll_token_request', async () => {
    const request = await submitApproval({
      service: 'mcp',
      title: 'one-shot destroy token — delete_service: media',
      payload: { caller: 'token:ci-bot', tokenRequestId: 'tr-1' },
      on_approve: { mintToken: { tokenRequestId: 'tr-1' } },
    });
    expect(await poll(request.id)).toMatchObject({
      status: 'pending',
      tokenRequestId: 'tr-1',
      collectWith: 'poll_token_request',
    });
  });

  it('does not echo the proposed tool\'s raw args back to the caller', async () => {
    const request = await proposeDestroyTierTool('delete_service', { name: 'media' });
    const polled = await poll(request.id);
    expect(polled.args).toBeUndefined();
    expect(polled.payload).toBeUndefined();
  });

  // The precise call #2651 made. It must still answer for its OWN id space and
  // must not start claiming this one.
  it('the same id is still not-found on get_access_request_status (separate store)', async () => {
    const request = await proposeDestroyTierTool();
    const { client } = await connect();
    const viaAccess = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: request.id },
    }));
    await client.close();
    expect(viaAccess.status).toBe('not-found');
    // ...but the approval verb resolves it, which is the whole point.
    expect((await poll(request.id)).status).toBe('pending');
  });

  // The other half of criterion 2: one-shot `request_token` mints an id in the
  // SAME store, so it must name the same verb — end to end, not by inspection.
  it('one-shot request_token names the poll verb and its approvalId resolves here', async () => {
    const { client } = await connect({ auth: { user: 'token:ci-bot', scopes: ['read'], tokenId: 't1' } });
    const filed = parse(await client.callTool({
      name: 'request_token',
      arguments: {
        scopes: ['destroy'],
        reason: 'delete one stale service',
        ttl_seconds: 300,
        one_shot_op: { tool_name: 'delete_service', service: 'media' },
      },
    }));
    await client.close();

    expect(filed.approvalId).toBeTruthy();
    expect(filed.message).toContain(`${APPROVAL_STATUS_TOOL}(approval_id="${filed.approvalId}")`);
    for (const outcome of ['pending', 'approved-executed', 'approved-failed', 'rejected']) {
      expect(filed.message).toContain(outcome);
    }
    // And the id it handed back really does resolve through that verb.
    expect(await poll(filed.approvalId)).toMatchObject({
      status: 'pending',
      collectWith: 'poll_token_request',
    });
  });

  // Criterion 3: no description may claim an id space it does not serve.
  it('the neighbouring poll tools disclaim this id space in their descriptions', async () => {
    const { client } = await connect();
    const byName = new Map((await client.listTools()).tools.map(t => [t.name, t.description ?? '']));
    await client.close();

    // The tool #2651 was invited to call must now say it does not serve an
    // approvalId, and must point at the verb that does.
    const accessDesc = byName.get('get_access_request_status')!;
    expect(accessDesc).toContain(APPROVAL_STATUS_TOOL);
    expect(accessDesc).toMatch(/ONLY ids returned by file_access_request/);
    // Same for the list tool that answered empty.
    expect(byName.get('list_requests')).toContain(APPROVAL_STATUS_TOOL);
    // And this tool names all four outcomes, so a caller learns them from the
    // registry without reading the source.
    const selfDesc = byName.get(APPROVAL_STATUS_TOOL)!;
    for (const outcome of ['pending', 'approved-executed', 'approved-failed', 'rejected']) {
      expect(selfDesc).toContain(outcome);
    }
  });

  it('is visible and callable to a READ-only token (a poll grants nothing)', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: ['read'], tokenId: 't-ro' } });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain(APPROVAL_STATUS_TOOL);
    const res = await client.callTool({ name: APPROVAL_STATUS_TOOL, arguments: { approval_id: 'nope' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
  });
});
