import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppConfig } from '@/lib/config';

// #1818: access-request / approval MCP tools. Mock the config store with an
// in-memory document so the file/list/poll round-trip is hermetic (no real
// config.json on disk) and the cap guard is exercisable.
let store: Partial<AppConfig>;

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfig: vi.fn(async () => store as AppConfig),
    updateConfig: vi.fn(async (updates: Partial<AppConfig>) => {
      // Mirror config.deepMerge's array-replace semantics for accessRequests.
      store = { ...store, ...updates };
      return store as AppConfig;
    }),
  };
});

const { createMcpServer } = await import('./server');

async function connectClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

function parse(res: unknown) {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

describe('access-request MCP tools (#1818)', () => {
  beforeEach(() => {
    store = {};
  });

  it('files a pending request and returns an id that can be polled', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Ada Lovelace', kind: 'resident', payload: 'voice profile enrolled', requested_by: 'solilos-agent' },
    }));
    expect(filed.ok).toBe(true);
    expect(filed.id).toBeTruthy();
    expect(filed.status).toBe('pending');

    // It landed in the central list with its provenance intact.
    expect((store.accessRequests ?? []).length).toBe(1);
    const stored = store.accessRequests![0];
    expect(stored.name).toBe('Ada Lovelace');
    expect(stored.kind).toBe('resident');
    expect(stored.payload).toBe('voice profile enrolled');
    expect(stored.requestedBy).toBe('solilos-agent');
    expect(stored.status).toBe('pending');

    // Pollable by id.
    const status = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: filed.id },
    }));
    expect(status.status).toBe('pending');
    expect(status.subject).toBe('Ada Lovelace');
    await client.close();
  });

  it('reflects approval (admin resolves) on the next poll', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Grace Hopper' },
    }));
    // Admin approves via the existing flow (mutates the same store).
    store.accessRequests![0].status = 'resolved';
    store.accessRequests![0].resolvedAt = new Date().toISOString();

    const status = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: filed.id },
    }));
    expect(status.status).toBe('resolved');
    await client.close();
  });

  it('returns not-found for an unknown id', async () => {
    const { client } = await connectClient();
    const status = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: 'does-not-exist' },
    }));
    expect(status.status).toBe('not-found');
    await client.close();
  });

  it('list_access_requests filters by status (pending by default)', async () => {
    const { client } = await connectClient();
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Pending One' } });
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Resolved One' } });
    store.accessRequests![1].status = 'resolved';

    const pending = parse(await client.callTool({ name: 'list_access_requests', arguments: {} }));
    expect(pending.requests.map((r: { subject: string }) => r.subject)).toEqual(['Pending One']);

    const all = parse(await client.callTool({ name: 'list_access_requests', arguments: { status: 'all' } }));
    expect(all.requests).toHaveLength(2);
    await client.close();
  });

  it('rejects filing once the pending cap is hit', async () => {
    const { client } = await connectClient();
    store.accessRequests = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      requestedAt: new Date().toISOString(),
      name: `req ${i}`,
      email: '',
      status: 'pending' as const,
    }));
    const res = await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'one too many' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Too many pending/);
    await client.close();
  });
});
