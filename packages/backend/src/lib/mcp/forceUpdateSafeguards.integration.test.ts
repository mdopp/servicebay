import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #2419, companion to server.forceUpdateSafeguards.test.ts: that file spies the
// two safeguard entry points, this one lets the REAL `safety.ts` + `notify.ts`
// run and stubs only their outermost effects (the tarball writer and the SMTP
// sender). So it proves the whole chain — per-action policy → snapshot →
// createSystemBackup, and → notifyDestructiveOp → sendEmailAlert — actually
// closes for a `manage_service` force-update, which a mocked-wrapper test
// cannot show.

const createSystemBackup = vi.fn(async (..._a: unknown[]) => '/mnt/data/servicebay/backups/x-auto.tar.gz');
const autoSnapshotWouldDuplicate = vi.fn(async () => false);
vi.mock('@/lib/systemBackup', () => ({
  createSystemBackup: (...a: unknown[]) => createSystemBackup(...a),
  autoSnapshotWouldDuplicate: () => autoSnapshotWouldDuplicate(),
}));

const sendEmailAlert = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/email', () => ({ sendEmailAlert: (...a: unknown[]) => sendEmailAlert(...a) }));

vi.mock('@/lib/config', () => ({ getConfig: vi.fn(async () => ({ mcp: { allowMutations: true } })) }));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    forceUpdateService: vi.fn(async () => ({ service: 'ollama', changed: true, stale: false, images: [] })),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    getServiceStatus: vi.fn(async () => 'Active: active (running)'),
  },
}));

async function callForceUpdate(args: Record<string, unknown>) {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer({
    auth: { user: 'token:companion', scopes: ['read', 'lifecycle'], tokenId: 't1' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const res = await client.callTool({ name: 'manage_service', arguments: args });
  await client.close();
  return res;
}

beforeEach(() => {
  createSystemBackup.mockClear();
  sendEmailAlert.mockClear();
  autoSnapshotWouldDuplicate.mockClear();
});

describe('force-update safeguards end-to-end through the real safety/notify modules (#2419)', () => {
  it('writes a real auto snapshot and sends the operator email', async () => {
    await callForceUpdate({ action: 'force-update', name: 'ollama', fresh: true });

    // The snapshot is the rewind point — tagged `auto` so retention prunes it.
    expect(createSystemBackup).toHaveBeenCalledWith('auto');
    // The email names the action (not just the tool) and carries the args, so
    // the operator can tell WHICH service was force-updated by whom.
    const [subject, bodyRaw] = sendEmailAlert.mock.calls[0] as unknown as [string, string];
    expect(subject).toBe('MCP destructive op: manage_service:force-update');
    expect(bodyRaw).toContain('token:companion');
    expect(bodyRaw).toContain('name: ollama');
    expect(bodyRaw).toContain('fresh: true');
  });

  it('leaves a plain restart with no snapshot and no email', async () => {
    await callForceUpdate({ action: 'restart', name: 'ollama' });
    expect(createSystemBackup).not.toHaveBeenCalled();
    expect(sendEmailAlert).not.toHaveBeenCalled();
  });
});
