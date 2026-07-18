import { describe, it, expect, beforeEach, vi } from 'vitest';

// Scope-filtered + deterministically-ordered tools/list (#2325).
//
// A token's advertised tool list contains only tools whose TOOL_SCOPES scope is
// within the token's granted scopes: a read-only token must NOT see
// mutate/destroy/exec tools. Enforcement is unchanged (safeHandler stays the
// authority) — a filtered-out tool called by id still fails at the scope gate.
// The list is sorted by name so it is deterministic + stable per token.

// Keep the safety/audit layer cheap so registering + listing tools is inert.
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
  createMcpServer,
  TOOL_SCOPES,
  MCP_KERNEL_TOOLS,
  isToolVisibleForScopes,
} from './server';
import type { ApiScope } from '@/lib/auth/apiScope';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function connect(opts?: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

const READ_ONLY: ApiScope[] = ['read'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scope-filtered tools/list (#2325)', () => {
  it('a read-only token sees only read-tier tools — no mutate/destroy/exec', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    // Every advertised tool must be a read-tier tool.
    for (const name of names) {
      expect(TOOL_SCOPES[name] ?? 'read', `${name} advertised to read-only token`).toBe('read');
    }
    // Concretely: no mutate/destroy/exec tool leaks into the list.
    expect(names).not.toContain('deploy_service'); // mutate
    expect(names).not.toContain('delete_service'); // destroy
    expect(names).not.toContain('exec_command');   // exec
    expect(names).not.toContain('reboot_node');    // reboot
    expect(names).not.toContain('manage_service'); // lifecycle

    // And it still sees the read core.
    expect(names).toContain('list_services');
    expect(names).toContain('get_logs');
  });

  it('a full-scope token sees the mutate/destroy/exec tools too', async () => {
    const { client } = await connect({
      auth: { user: 'token:admin', scopes: ['read', 'lifecycle', 'mutate', 'destroy', 'exec', 'reboot'] },
    });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('deploy_service');
    expect(names).toContain('delete_service');
    expect(names).toContain('exec_command');
    expect(names).toContain('reboot_node');
    expect(names).toContain('manage_service');
  });

  it('no-auth (cookie/operator) sees every registered tool', async () => {
    const { client: full } = await connect({
      auth: { user: 't', scopes: ['read', 'lifecycle', 'mutate', 'destroy', 'exec', 'reboot'] },
    });
    const { client: anon } = await connect();
    const fullNames = new Set((await full.listTools()).tools.map(t => t.name));
    const anonNames = (await anon.listTools()).tools.map(t => t.name);
    // The anon (no-auth) list is a superset-or-equal of the full-scope list.
    for (const n of fullNames) expect(anonNames).toContain(n);
  });

  it('the kernel set is entirely visible to a read-only token', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const k of MCP_KERNEL_TOOLS) {
      expect(names, `kernel tool ${k} visible to read-only`).toContain(k);
      // Kernel must stay read-tier so it's always advertisable.
      expect(TOOL_SCOPES[k] ?? 'read').toBe('read');
    }
  });
});

describe('deterministic ordering (#2325)', () => {
  it('tools are sorted by name, stable across repeated requests', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    const first = (await client.listTools()).tools.map(t => t.name);
    const second = (await client.listTools()).tools.map(t => t.name);

    const sorted = [...first].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(first).toEqual(sorted);          // sorted by name
    expect(second).toEqual(first);          // stable across requests
  });
});

describe('enforcement unchanged — visibility != authorization (#2325)', () => {
  it('a filtered-out tool still fails at the scope gate when called by id', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    // deploy_service is hidden from the read-only list, but calling it by id
    // must still be refused by safeHandler's scope gate (not "tool not found").
    const res = await client.callTool({
      name: 'deploy_service',
      arguments: { name: 'x', kubeContent: 'apiVersion: v1\nkind: Pod' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text?: string }[])[0]?.text ?? '';
    expect(text).toMatch(/scope 'mutate' required/i);
    expect(text).not.toMatch(/not found/i);
  });
});

describe('propose scope — independent, low-privilege capability (#2326)', () => {
  it('a propose-only token sees propose_learning and NOT read/mutate tools', async () => {
    const { client } = await connect({ auth: { user: 'token:proposer', scopes: ['propose'] } });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('propose_learning');
    // propose is NOT on the read<…<exec ladder: a propose-only token sees no
    // read/lifecycle/mutate/destroy/exec tools.
    expect(names).not.toContain('list_services'); // read
    expect(names).not.toContain('manage_service'); // lifecycle
    expect(names).not.toContain('deploy_service'); // mutate
    expect(names).not.toContain('delete_service'); // destroy
    expect(names).not.toContain('exec_command'); // exec
    // Every advertised tool must be a propose-tier tool.
    for (const name of names) {
      expect(TOOL_SCOPES[name] ?? 'read', `${name} advertised to propose-only token`).toBe('propose');
    }
  });

  it('a read-only token does NOT see propose_learning', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).not.toContain('propose_learning');
  });

  it('a mutate token does NOT implicitly get propose (no ladder implication)', async () => {
    const { client } = await connect({ auth: { user: 'token:m', scopes: ['read', 'mutate'] } });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).not.toContain('propose_learning');
    expect(isToolVisibleForScopes('propose_learning', ['read', 'mutate', 'destroy', 'exec'])).toBe(false);
  });

  it('calling propose_learning without the propose scope is refused at the gate', async () => {
    const { client } = await connect({ auth: { user: 'token:ro', scopes: [...READ_ONLY] } });
    const res = await client.callTool({
      name: 'propose_learning',
      arguments: { title: 't', whenToUse: 'w', kind: 'guide', tags: [], body: 'b' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text?: string }[])[0]?.text ?? '';
    expect(text).toMatch(/scope 'propose' required/i);
    expect(text).not.toMatch(/not found/i);
  });
});

describe('isToolVisibleForScopes helper (#2325)', () => {
  it('mirrors the scope gate; undefined scopes ⇒ everything visible', () => {
    expect(isToolVisibleForScopes('deploy_service', ['read'])).toBe(false);
    expect(isToolVisibleForScopes('deploy_service', ['read', 'mutate'])).toBe(true);
    expect(isToolVisibleForScopes('list_services', ['read'])).toBe(true);
    // destroy implies exec + reboot (apiScope ladder).
    expect(isToolVisibleForScopes('exec_command', ['destroy'])).toBe(true);
    expect(isToolVisibleForScopes('reboot_node', ['destroy'])).toBe(true);
    // No auth ⇒ all visible.
    expect(isToolVisibleForScopes('exec_command', undefined)).toBe(true);
  });
});
