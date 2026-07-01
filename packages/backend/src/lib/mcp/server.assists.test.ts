import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #2146: list_assists / get_assist MCP tools over the extensible assist catalog.
// Mock the catalog so these tests assert wiring (registration, read scope, arg
// pass-through, result shaping) independent of on-disk assist files.
const listAssists = vi.fn();
const getAssist = vi.fn();
vi.mock('@/lib/assists/catalog', () => ({
  ASSIST_KINDS: ['guide', 'recipe', 'template', 'checklist', 'footgun', 'snippet'],
  listAssists: (...a: unknown[]) => listAssists(...a),
  getAssist: (...a: unknown[]) => getAssist(...a),
}));

// Keep the safety gate helpers permissive (read tools don't snapshot anyway).
vi.mock('./safety', () => ({
  guardMutation: vi.fn(async () => null),
  guardExec: vi.fn(async () => null),
  snapshotBeforeMutation: vi.fn(async () => undefined),
}));

vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn(async () => [{ Name: 'box', URI: '', Default: true }]),
  getNodeConnection: vi.fn(),
}));

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

function firstText(res: unknown): string {
  const content = (res as { content: Array<{ text: string }> }).content;
  return content[0].text;
}

beforeEach(() => {
  listAssists.mockReset();
  getAssist.mockReset();
});

describe('assist MCP tools (#2146)', () => {
  it('registers list_assists + get_assist at read scope', async () => {
    const { TOOL_SCOPES } = await import('./server');
    expect(TOOL_SCOPES.list_assists).toBe('read');
    expect(TOOL_SCOPES.get_assist).toBe('read');
  });

  it('exposes both via the tools/list handshake', async () => {
    const { client } = await connectClient();
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('list_assists');
    expect(names).toContain('get_assist');
    await client.close();
  });

  it('list_assists forwards query + kind and returns the catalog result', async () => {
    listAssists.mockResolvedValue([
      { id: 'create-service', title: 'Create & deploy a new service', kind: 'recipe', whenToUse: 'x', tags: [], source: 'Built-in' },
    ]);
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'list_assists', arguments: { query: 'deploy a service', kind: 'recipe' } });
    expect(listAssists).toHaveBeenCalledWith({ query: 'deploy a service', kind: 'recipe' });
    expect(firstText(res)).toContain('create-service');
    await client.close();
  });

  it('get_assist returns raw markdown; unknown id is an error', async () => {
    getAssist.mockImplementation(async (id: string) =>
      id === 'create-service' ? '---\ntitle: Create\n---\nbody' : null,
    );
    const { client } = await connectClient();

    const ok = await client.callTool({ name: 'get_assist', arguments: { id: 'create-service' } });
    expect(getAssist).toHaveBeenCalledWith('create-service');
    expect(firstText(ok)).toContain('title: Create');
    expect((ok as { isError?: boolean }).isError).toBeFalsy();

    const bad = await client.callTool({ name: 'get_assist', arguments: { id: 'nope' } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });
});
