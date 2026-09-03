/**
 * #2756 — `restore_trashed_service` used to answer `Service "x" restored from
 * trash.` and nothing else, while the systemd unit stayed `inactive/dead`. The
 * restore now starts the unit, so the tool must say what systemd is actually
 * doing — and in particular must make "still coming up" (poll me) legible as
 * something other than "up" or "broken".
 *
 * Drives the real MCP server over the in-memory transport with a stubbed
 * ServiceManager, and asserts the caller-visible text per startup state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

type Startup = {
  state: 'active' | 'converging' | 'failed' | 'error';
  alreadyActive: boolean;
  waitedMs: number;
  runState: { activeState: string; subState: string; invocationId: string; activeEnterStamp: string };
  detail: string;
};

let startup: Startup;

const serviceManagerMock = {
  restoreTrashedService: vi.fn(async () => ({ service: 'radicale', capabilityFailures: [], startup })),
};

vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: serviceManagerMock }));

async function restore(): Promise<string> {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const res = (await client.callTool({
    name: 'restore_trashed_service',
    arguments: { id: '2026-09-03T09-15-00-000Z-radicale', node: 'local' },
  })) as { isError?: boolean; content?: { text?: string }[] };
  await client.close();
  expect(res.isError).toBeFalsy();
  return res.content?.map(c => c.text ?? '').join('\n') ?? '';
}

function startupOf(state: Startup['state'], detail: string): Startup {
  return {
    state,
    alreadyActive: false,
    waitedMs: 1_000,
    runState: { activeState: 'inactive', subState: 'dead', invocationId: '', activeEnterStamp: '0' },
    detail,
  };
}

beforeEach(() => {
  serviceManagerMock.restoreTrashedService.mockClear();
});

describe('restore_trashed_service reports the restored unit\'s startup state (#2756)', () => {
  it('says the unit is up when the start settled', async () => {
    startup = startupOf('active', 'radicale.service reported active/running after 9.0s.');
    const text = await restore();
    expect(text).toContain('restored from trash');
    expect(text).toContain('active/running');
    expect(text).not.toContain('Poll list_services');
  });

  it('marks a still-booting unit as converging and tells the caller to poll', async () => {
    startup = startupOf('converging', 'radicale.service is still starting (activating/start after 30.0s).');
    const text = await restore();
    expect(text).toContain('still starting');
    expect(text).toContain('Poll list_services until it reports active');
  });

  it('warns when systemd reports the restored unit failed', async () => {
    startup = startupOf('failed', 'radicale.service failed to start (failed/failed after 2.0s).');
    const text = await restore();
    expect(text).toContain('⚠️');
    expect(text).toContain('failed to start');
    expect(text).not.toContain('Poll list_services');
  });
});
