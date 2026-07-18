import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Learning-proposal approval wiring (#2326 slice 3): a pending proposal is
// listable/visible for admin review; an admin approve/reject flips the status
// (mirroring the access-request approve/deny surface) WITHOUT landing a file;
// authority is enforced at the surface (MCP read tools are read-only, there is
// NO MCP approve tool, and a propose-scoped token cannot see the review queue).

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-proposals-approval-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

// Pin known built-in ids so submit's collision check is hermetic.
vi.mock('@/lib/assists/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/assists/catalog')>();
  return {
    ...actual,
    listBuiltinAssistIds: vi.fn().mockResolvedValue(['servicebay-overview']),
  };
});

// Keep the MCP safety/audit layer inert (same shape as mcp_propose_learning).
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

import {
  submitProposal,
  approveProposal,
  rejectProposal,
  getProposal,
  listProposalsForReview,
  getProposalForReview,
} from '@/lib/assists/proposals';
import { DATA_DIR } from '@/lib/dirs';
import { createMcpServer } from '@/lib/mcp/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function connect(opts?: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client };
}

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

const VALID = {
  title: 'A brand new companion recipe',
  whenToUse: 'When you want a runtime-only companion.',
  kind: 'recipe' as const,
  tags: ['x'],
  body: '# body\n',
  assessment: { pros: ['useful'], cons: ['maintenance'], redundancyNote: 'none' },
};

/** The additive, namespaced landing dir slice 4 writes approved proposals to. */
function localAssistsDir() {
  return path.join(DATA_DIR, 'local-assists', 'landed');
}

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-proposals-approval-'));
  vi.clearAllMocks();
});
afterEach(async () => {
  await fs.rm(dirState.dir, { recursive: true, force: true });
});

describe('learning-proposal approval store (#2326 s3)', () => {
  it('a pending proposal is visible for admin review with frontmatter + body + assessment', async () => {
    const p = await submitProposal(VALID, 'token:proposer');
    const review = await listProposalsForReview('pending');
    expect(review).toHaveLength(1);
    const v = review[0];
    expect(v.id).toBe(p.id);
    expect(v.status).toBe('pending');
    expect(v.title).toBe(VALID.title);
    expect(v.body).toBe(VALID.body.trim());
    expect(v.assessment).toEqual({ pros: ['useful'], cons: ['maintenance'], redundancyNote: 'none' });
    expect(v.submittedBy).toBe('token:proposer');
    // No same-id sibling yet.
    expect(v.siblingProposalIds).toEqual([]);
  });

  it('surfaces a same-id sibling proposal so the admin knows a duplicate exists', async () => {
    // Two proposals whose titles slug to the SAME local/<slug> id.
    const a = await submitProposal({ ...VALID, title: 'Shared Title' });
    const b = await submitProposal({ ...VALID, title: 'Shared  Title' });
    expect(a.assistId).toBe(b.assistId);
    const va = await getProposalForReview(a.id);
    expect(va!.siblingProposalIds).toEqual([b.id]);
  });

  it('admin approve stamps who/when and lands the assist (#2326 s4)', async () => {
    const p = await submitProposal(VALID, 'token:proposer');
    const outcome = await approveProposal(p.id, 'session:admin');
    expect(outcome.result).toBe('ok');
    const after = await getProposal(p.id);
    // s4: clean content lands -> status `landed`.
    expect(after!.status).toBe('landed');
    expect(after!.resolvedBy).toBe('session:admin');
    expect(after!.resolvedAt).toBeTruthy();
  });

  it('admin reject transitions pending -> rejected', async () => {
    const p = await submitProposal(VALID);
    const outcome = await rejectProposal(p.id, 'session:admin');
    expect(outcome.result).toBe('ok');
    const after = await getProposal(p.id);
    expect(after!.status).toBe('rejected');
    expect(after!.resolvedBy).toBe('session:admin');
  });

  it('approving lands a file under local-assists (#2326 s4)', async () => {
    const p = await submitProposal(VALID);
    await approveProposal(p.id, 'session:admin');
    // s4: clean content lands -> status `landed` and a `.md` is written.
    expect((await getProposal(p.id))!.status).toBe('landed');
    const landed = await fs.readdir(localAssistsDir()).catch(() => []);
    expect(landed).toHaveLength(1);
  });

  it('resolving a non-pending proposal is a no-op (not-pending)', async () => {
    const p = await submitProposal(VALID);
    await approveProposal(p.id, 'session:admin');
    const again = await rejectProposal(p.id, 'session:other');
    expect(again.result).toBe('not-pending');
    // Status unchanged — the first decision (landed) stands.
    expect((await getProposal(p.id))!.status).toBe('landed');
  });

  it('resolving an unknown id reports not-found', async () => {
    const outcome = await approveProposal('no-such-id', 'session:admin');
    expect(outcome.result).toBe('not-found');
  });
});

describe('learning-proposal review MCP tools (#2326 s3)', () => {
  it('an admin (read scope) lists pending proposals with body + assessment', async () => {
    await submitProposal(VALID, 'token:proposer');
    const { client } = await connect({ auth: { user: 'session:admin', scopes: ['read'] } });
    const out = parse(await client.callTool({ name: 'list_learning_proposals', arguments: {} }));
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].status).toBe('pending');
    expect(out.proposals[0].body).toBe(VALID.body.trim());
    expect(out.proposals[0].assessment).toEqual({ pros: ['useful'], cons: ['maintenance'], redundancyNote: 'none' });
    expect(out.proposals[0].hasSameIdProposal).toBe(false);
  });

  it('get_learning_proposal returns one proposal by id, not-found for unknown', async () => {
    const p = await submitProposal(VALID);
    const { client } = await connect({ auth: { user: 'session:admin', scopes: ['read'] } });
    const found = parse(await client.callTool({ name: 'get_learning_proposal', arguments: { id: p.id } }));
    expect(found.id).toBe(p.id);
    expect(found.title).toBe(VALID.title);
    const missing = parse(await client.callTool({ name: 'get_learning_proposal', arguments: { id: 'nope' } }));
    expect(missing.status).toBe('not-found');
  });

  it('a propose-scoped submitter cannot see the review queue (no read scope) and has no approve tool', async () => {
    await submitProposal(VALID, 'token:proposer');
    const { client } = await connect({ auth: { user: 'token:proposer', scopes: ['propose'] } });

    // The review tools are read-scoped — a propose-only token is refused.
    const listRes = await client.callTool({ name: 'list_learning_proposals', arguments: {} });
    expect(listRes.isError).toBe(true);
    expect((listRes.content as { text?: string }[])[0]?.text ?? '').toMatch(/scope 'read' required/i);

    // There is NO MCP approve/reject tool at all — approval is admin-only
    // (a frontend route), so a submitter can never approve its own proposal.
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    expect(names).not.toContain('approve_learning_proposal');
    expect(names).not.toContain('reject_learning_proposal');
  });
});
