import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #2397: `manage_service` only knew start|stop|restart, none of which re-check
// the registry — so an MCP client had no way to roll a freshly pushed image
// onto a running service except a hand-rolled podman pull + restart. These
// cases assert the new `force-update` action over a real SDK round-trip, with
// ServiceManager mocked so no agent/box is involved.
const forceUpdateService = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
  service: 'media', node: 'Local', mode: 'pull', images: [], recreated: [],
  changed: false, stale: false, status: 'active', logs: [],
}));
const restartService = vi.fn(async (..._args: unknown[]) => undefined);
const getServiceStatus = vi.fn(async () => 'Active: active (running)');

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    forceUpdateService: (...args: unknown[]) => forceUpdateService(...args),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: (...args: unknown[]) => restartService(...args),
    getServiceStatus: () => getServiceStatus(),
  },
}));

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

describe('manage_service force-update (#2397)', () => {
  beforeEach(() => {
    forceUpdateService.mockClear();
    restartService.mockClear();
  });

  it('advertises force-update as an action and explains the fresh fallback', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'manage_service');
    const action = (tool?.inputSchema?.properties as Record<string, { enum?: string[] }>)?.action;
    expect(action?.enum).toEqual(['start', 'stop', 'restart', 'force-update']);
    // The description has to teach the trap, or a client keeps reaching for
    // restart and wondering why the new image never lands.
    expect(tool?.description).toMatch(/force-update/);
    expect(tool?.description).toMatch(/restart.*never re-checks the registry/i);
    expect(tool?.description).toMatch(/fresh/);
    await client.close();
  });

  it('routes action=force-update to forceUpdateService and returns its report', async () => {
    forceUpdateService.mockResolvedValueOnce({
      service: 'media', node: 'Local', mode: 'pull', recreated: ['media-jellyfin'],
      images: [{ image: 'j:latest', before: 'sha256:a', registry: 'sha256:b', after: 'sha256:b', pulled: true, changed: true, stale: false, removedLocally: false }],
      changed: true, stale: false, status: 'Active: activating', logs: [],
    });
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'media' } });
    expect(forceUpdateService).toHaveBeenCalledWith('Local', 'media', { fresh: undefined });
    // No restart-only fallback: the tool must not quietly do the old thing.
    expect(restartService).not.toHaveBeenCalled();
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain('"changed": true');
    expect(text).toContain('sha256:b');
    await client.close();
  });

  it('passes fresh: true through for the stuck-image fallback', async () => {
    const { client } = await connectClient();
    await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama', fresh: true } });
    expect(forceUpdateService).toHaveBeenCalledWith('Local', 'ollama', { fresh: true });
    await client.close();
  });

  it('still routes restart the old way (no regression in the existing actions)', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'manage_service', arguments: { action: 'restart', name: 'media' } });
    expect(restartService).toHaveBeenCalledWith('Local', 'media');
    expect(forceUpdateService).not.toHaveBeenCalled();
    expect((res.content as { text: string }[])[0].text).toContain('active (running)');
    await client.close();
  });
});
