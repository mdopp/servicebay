import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #2139: MCP scoped-token request tools (request_token / poll_token_request /
// list_requests(type="token")). The store is file-backed under DATA_DIR, so use a
// real-fs temp dir per test (mirrors auth/tokenRequests.test.ts).
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-tokreq-'));
});
afterEach(async () => {
  const { flushPendingStamps } = await import('@/lib/auth/apiTokens');
  await flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer({ auth: { user: 'agent:tester', scopes: ['read'] } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

function parse(res: unknown) {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

describe('request_token / poll_token_request MCP tools (#2139)', () => {
  it('a read-scope token can request, and poll returns pending before approval', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'request_token',
      arguments: { scopes: ['read', 'lifecycle'], reason: 'deploy one service', ttl_seconds: 3600 },
    }));
    expect(filed.ok).toBe(true);
    expect(filed.id).toBeTruthy();
    expect(filed.status).toBe('pending');
    // No token in the filing response.
    expect(filed.token).toBeUndefined();

    const polled = parse(await client.callTool({ name: 'poll_token_request', arguments: { id: filed.id } }));
    expect(polled.status).toBe('pending');
    expect(polled.token).toBeNull();

    // Visible on the audit list with the caller identity captured.
    const listed = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'token' } }));
    expect(listed.requests.map((r: { id: string }) => r.id)).toContain(filed.id);
    expect(listed.requests[0].requestedBy).toBe('agent:tester');
    await client.close();
  });

  it('after admin approval (narrowed scopes) poll hands over a usable token once', async () => {
    const { client } = await connectClient();
    const filed = parse(await client.callTool({
      name: 'request_token',
      arguments: { scopes: ['read', 'lifecycle', 'mutate'], reason: 'r', ttl_seconds: 3600 },
    }));

    // Admin approves out-of-band with fewer scopes (least privilege).
    const { approveTokenRequest } = await import('@/lib/auth/tokenRequests');
    await approveTokenRequest(filed.id, { scopes: ['read'], ttlSecs: 600, approvedBy: 'admin' });

    const first = parse(await client.callTool({ name: 'poll_token_request', arguments: { id: filed.id } }));
    expect(first.status).toBe('approved');
    expect(first.token).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]+$/);
    expect(first.grantedScopes).toEqual(['read']);

    // The token authenticates with exactly the granted scope.
    const { verifyToken } = await import('@/lib/auth/apiTokens');
    const verified = await verifyToken(first.token);
    expect(verified!.scopes).toEqual(['read']);

    // Second poll no longer yields the secret.
    const second = parse(await client.callTool({ name: 'poll_token_request', arguments: { id: filed.id } }));
    expect(second.token).toBeNull();
    await client.close();
  });

  it('list_requests(type="token") filters by status and never leaks a secret', async () => {
    const { client } = await connectClient();
    const a = parse(await client.callTool({ name: 'request_token', arguments: { scopes: ['read'], reason: 'a', ttl_seconds: 60 } }));
    const b = parse(await client.callTool({ name: 'request_token', arguments: { scopes: ['read'], reason: 'b', ttl_seconds: 60 } }));

    const { approveTokenRequest, denyTokenRequest } = await import('@/lib/auth/tokenRequests');
    await approveTokenRequest(a.id);
    await denyTokenRequest(b.id);

    const approved = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'token', status: 'approved' } }));
    expect(approved.requests.map((r: { id: string }) => r.id)).toEqual([a.id]);
    // The one-time secret is never present on the list view.
    expect(JSON.stringify(approved)).not.toMatch(/pendingSecret/);

    const denied = parse(await client.callTool({ name: 'list_requests', arguments: { type: 'token', status: 'denied' } }));
    expect(denied.requests.map((r: { id: string }) => r.id)).toEqual([b.id]);
    await client.close();
  });

  it('a bad TTL / empty scope request is an error, not a silent pass', async () => {
    const { client } = await connectClient();
    // Zod rejects a non-positive ttl before the store even sees it.
    const res = await client.callTool({ name: 'request_token', arguments: { scopes: ['read'], reason: 'r', ttl_seconds: 0 } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
