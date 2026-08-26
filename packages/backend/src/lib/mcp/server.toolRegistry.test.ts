import { describe, it, expect, vi } from 'vitest';

// Registry completeness after the per-tool-group split (#2384).
//
// `createMcpServer` no longer registers tools inline — it calls one
// `registerXTools()` per group module in `tools/`. That makes a whole GROUP
// droppable by a one-line mistake (a forgotten call, a bad merge) without any
// type error and without any existing test failing: the tools simply stop
// existing. These assertions close that hole by pinning the registered set
// against `TOOL_SCOPES`, which is the independent, declarative list of every
// tool the MCP surface is supposed to expose.

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

import { createMcpServer, TOOL_SCOPES } from './server';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** Names advertised by a no-auth (operator) server — i.e. every tool. */
async function registeredToolNames(): Promise<string[]> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map(t => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP tool registry completeness (#2384)', () => {
  it('registers every tool named in TOOL_SCOPES — no tool-group module is missing', async () => {
    const registered = new Set(await registeredToolNames());
    const missing = Object.keys(TOOL_SCOPES).filter(name => !registered.has(name));
    expect(missing, 'tools in TOOL_SCOPES that no group module registers').toEqual([]);
  });

  it('registers no tool that TOOL_SCOPES does not cover — nothing escapes the scope gate', async () => {
    const names = await registeredToolNames();
    const unscoped = names.filter(name => !(name in TOOL_SCOPES));
    // An unscoped tool silently defaults to `read` in safeHandler, so a
    // mutating tool added without a TOOL_SCOPES entry would be callable by a
    // read-only token. Fail loudly instead.
    expect(unscoped, 'registered tools with no TOOL_SCOPES entry').toEqual([]);
  });

  it('exposes exactly the 63 tools the surface declares', async () => {
    // Hard count, deliberately: the split was a pure mechanical extraction, so
    // the surface must not shrink OR grow by accident. Bump this number in the
    // same commit that adds or removes a tool.
    const names = await registeredToolNames();
    expect(names).toHaveLength(63);
    expect(new Set(names).size, 'duplicate tool registration').toBe(names.length);
  });
});
