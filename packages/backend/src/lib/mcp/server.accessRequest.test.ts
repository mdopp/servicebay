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

  it('stores the optional username so the admin gets the auto-approve path', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Ada Lovelace', kind: 'resident', requested_by: 'solilos-agent', username: 'ada.lovelace' },
    }));
    expect(filed.ok).toBe(true);
    const stored = store.accessRequests![0];
    // canAutoApprove in the admin UI is Boolean(r.username) — it must be set.
    expect(stored.username).toBe('ada.lovelace');
    await client.close();
  });

  it('rejects an invalid username (uppercase/spaces) instead of storing it', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Bad Login', username: 'Ada Lovelace' },
    });
    expect(res.isError).toBe(true);
    expect(store.accessRequests ?? []).toHaveLength(0);
    await client.close();
  });

  it('reports approved vs denied distinctly on the next poll (#1824)', async () => {
    const { client } = await connectClient();
    const approvedReq = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Grace Hopper' },
    }));
    const deniedReq = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Margaret Hamilton' },
    }));
    // Admin approves one (POST .../approve) and denies the other (PATCH).
    store.accessRequests![0].status = 'approved';
    store.accessRequests![0].resolvedAt = new Date().toISOString();
    store.accessRequests![1].status = 'denied';
    store.accessRequests![1].resolvedAt = new Date().toISOString();

    const approved = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: approvedReq.id },
    }));
    expect(approved.status).toBe('approved');

    const denied = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: deniedReq.id },
    }));
    expect(denied.status).toBe('denied');
    await client.close();
  });

  it('surfaces a legacy "resolved" entry as "approved" (#1824 back-compat)', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'file_access_request',
      arguments: { subject: 'Legacy Entry' },
    }));
    // Old PATCH route wrote 'resolved'; the approve path was the only
    // historical resolution, so it must read back as 'approved'.
    store.accessRequests![0].status = 'resolved';
    store.accessRequests![0].resolvedAt = new Date().toISOString();

    const status = parse(await client.callTool({
      name: 'get_access_request_status',
      arguments: { id: filed.id },
    }));
    expect(status.status).toBe('approved');
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

  it('list_requests(type="access") filters by status (pending by default, approved/denied/all)', async () => {
    const { client } = await connectClient();
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Pending One' } });
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Approved One' } });
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Denied One' } });
    await client.callTool({ name: 'file_access_request', arguments: { subject: 'Legacy Resolved' } });
    store.accessRequests![1].status = 'approved';
    store.accessRequests![2].status = 'denied';
    store.accessRequests![3].status = 'resolved'; // legacy → approved

    const pending = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'access' } }));
    expect(pending.requests.map((r: { subject: string }) => r.subject)).toEqual(['Pending One']);

    const approved = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'access', status: 'approved' } }));
    expect(approved.requests.map((r: { subject: string }) => r.subject)).toEqual(['Approved One', 'Legacy Resolved']);
    // Legacy 'resolved' is normalized in the response too.
    expect(approved.requests.every((r: { status: string }) => r.status === 'approved')).toBe(true);

    const denied = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'access', status: 'denied' } }));
    expect(denied.requests.map((r: { subject: string }) => r.subject)).toEqual(['Denied One']);

    const all = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'access', status: 'all' } }));
    expect(all.requests).toHaveLength(4);
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
