import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { destructiveCallLabel } from './toolPolicy';
import type { ApiScope } from '@/lib/auth/apiScope';

// #2419: `manage_service` is one `lifecycle`-scoped tool with four actions, and
// `force-update` re-pulls the image + force-removes the service's containers
// (in `fresh` mode it deletes the local image first) — far past the reversible
// start/stop/restart the tier documents. The architect decision was to KEEP the
// lifecycle tier (lifecycle-only tokens and the companion app must not lose the
// action) and make it honest with the destructive-call safeguards instead. So
// these cases assert exactly that split: the snapshot + operator email fire for
// action=force-update and for nothing else the tool does, and the scope gate is
// unchanged (still `lifecycle`, still no human-approval parking).

const forceUpdateService = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
  service: 'ollama', node: 'Local', mode: 'pull', images: [], recreated: [],
  changed: false, stale: false, status: 'active', logs: [],
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    forceUpdateService: (...args: unknown[]) => forceUpdateService(...args),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    getServiceStatus: vi.fn(async () => 'Active: active (running)'),
  },
}));

const snapshotBeforeMutation = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./safety', () => ({
  guardMutation: vi.fn(async () => null),
  guardExec: vi.fn(async () => null),
  snapshotBeforeMutation: (...a: unknown[]) => snapshotBeforeMutation(...a),
}));

const notifyDestructiveOp = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./notify', () => ({
  notifyDestructiveOp: (...a: unknown[]) => notifyDestructiveOp(...a),
}));

async function connectClient(scopes?: ApiScope[]) {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer(
    scopes ? { auth: { user: 'token:companion', scopes, tokenId: 't1' } } : undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

beforeEach(() => {
  forceUpdateService.mockClear();
  snapshotBeforeMutation.mockReset();
  notifyDestructiveOp.mockReset();
});

describe('manage_service force-update safeguards (#2419)', () => {
  it('snapshots BEFORE the force-update runs, labelled with the action', async () => {
    const order: string[] = [];
    snapshotBeforeMutation.mockImplementation(async () => { order.push('snapshot'); });
    forceUpdateService.mockImplementation(async () => { order.push('force-update'); return { service: 'ollama', images: [] }; });
    const { client } = await connectClient();
    await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama', fresh: true } });
    expect(order).toEqual(['snapshot', 'force-update']);
    expect(snapshotBeforeMutation).toHaveBeenCalledWith(
      'manage_service:force-update',
      expect.objectContaining({ action: 'force-update', name: 'ollama', fresh: true }),
    );
    await client.close();
  });

  it('emails the operator after a successful force-update, naming the action and caller', async () => {
    const { client } = await connectClient(['read', 'lifecycle']);
    await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama' } });
    expect(notifyDestructiveOp).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'manage_service:force-update',
      caller: 'token:companion',
      args: expect.objectContaining({ action: 'force-update', name: 'ollama' }),
    }));
    await client.close();
  });

  it('does NOT snapshot or email for the reversible actions', async () => {
    const { client } = await connectClient();
    for (const action of ['start', 'stop', 'restart']) {
      await client.callTool({ name: 'manage_service', arguments: { action, name: 'ollama' } });
    }
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    expect(notifyDestructiveOp).not.toHaveBeenCalled();
    await client.close();
  });

  it('still snapshots but does not email when the force-update fails', async () => {
    forceUpdateService.mockRejectedValueOnce(new Error('pull failed'));
    const { client } = await connectClient();
    await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama' } });
    expect(snapshotBeforeMutation).toHaveBeenCalledTimes(1);
    expect(notifyDestructiveOp).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps the lifecycle tier: a lifecycle token runs force-update inline, no approval parking', async () => {
    const { client } = await connectClient(['read', 'lifecycle']);
    const res = await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama' } });
    expect(forceUpdateService).toHaveBeenCalledWith('Local', 'ollama', { fresh: undefined });
    const text = (res.content as { text: string }[])[0].text;
    expect(text).not.toContain('pending_approval');
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it('still refuses a read-only token (the scope gate is unchanged)', async () => {
    const { client } = await connectClient(['read']);
    const res = await client.callTool({ name: 'manage_service', arguments: { action: 'force-update', name: 'ollama' } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/scope 'lifecycle' required/);
    expect(forceUpdateService).not.toHaveBeenCalled();
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('destructiveCallLabel', () => {
  it('labels a whole-tool destructive call by its tool name', () => {
    expect(destructiveCallLabel('deploy_service', { name: 'media' })).toBe('deploy_service');
  });

  it('labels a per-action destructive call with tool:action', () => {
    expect(destructiveCallLabel('manage_service', { action: 'force-update' })).toBe('manage_service:force-update');
  });

  it('returns null for the reversible actions and for non-destructive tools', () => {
    expect(destructiveCallLabel('manage_service', { action: 'restart' })).toBeNull();
    expect(destructiveCallLabel('manage_service', {})).toBeNull();
    expect(destructiveCallLabel('list_services', { action: 'force-update' })).toBeNull();
    expect(destructiveCallLabel('manage_service')).toBeNull();
  });
});
