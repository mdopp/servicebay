/**
 * #2533 — the MCP deploy surface must be no weaker than the HTTP one.
 *
 * #2503 closed `POST /api/services`: the whole body is parsed by a strict zod
 * schema and companion files are contained to the deploy's own scope. The two
 * MCP tools that reach the SAME sink — `deploy_service` and
 * `update_service_yaml` — were left on bare `z.string()` for the privileged
 * fields:
 *
 *   yamlFileName      → written verbatim as
 *                       `~/.config/containers/systemd/<yamlFileName>`
 *                       (services/serviceLifecycle.ts writeFile), so a
 *                       separator or `..` escapes the Quadlet directory.
 *   extraFiles[].path → its parent is interpolated UNQUOTED into
 *                       `mkdir -p <dir>` and the write auto-retries with
 *                       `sudo: true` (writeExtraConfigFiles), so a shell
 *                       metacharacter is command execution and a well-formed
 *                       path outside the service is a root-owned write.
 *
 * These are attempted-injection tests through the MCP path specifically: they
 * drive the REAL MCP server over the in-memory transport and assert both that
 * the call is refused AND that no ServiceManager method was entered (nothing
 * reached exec). The positive cases prove a legitimate deploy still lands.
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

// The containment check reads DATA_DIR from config; the safety layer reads
// `mcp.allowMutations` from the same call. Keep the rest of the module real.
vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ templateSettings: { DATA_DIR: '/mnt/data/stacks' } })),
  };
});

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

/** Normalises the two shapes a rejection can take (a thrown McpError for a
 *  schema failure, or an `isError` result from the handler). */
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

const noDeployReached = () => {
  expect(serviceManagerMock.deployKubeService, 'deployKubeService must not be reached').not.toHaveBeenCalled();
  expect(serviceManagerMock.deployContainerQuadlet, 'deployContainerQuadlet must not be reached').not.toHaveBeenCalled();
};

/** A manifest declaring one hostPath — the deploy's own config volume. */
const POD_YAML = [
  'apiVersion: v1',
  'kind: Pod',
  'metadata:',
  '  name: media',
  'spec:',
  '  volumes:',
  '    - name: config',
  '      hostPath:',
  '        path: /mnt/data/stacks/media/config',
  '  containers:',
  '    - name: app',
  '      image: docker.io/library/nginx:latest',
  '',
].join('\n');

// A separator, a traversal segment or a shell metacharacter in the companion
// filename escapes `~/.config/containers/systemd/`.
const HOSTILE_YAML_FILE_NAMES = [
  '../../../../etc/systemd/system/evil.service',
  'sub/dir/media.yml',
  '/etc/passwd',
  'media.yml; touch /tmp/pwned',
  'media$(id).yml',
  'media`id`.yml',
  '..',
  '.ssh',
  'media yml',
  'media|tee.yml',
];

// Malformed paths — rejected by the shared `HostFilePath` schema before the
// handler runs.
const MALFORMED_EXTRA_FILE_PATHS = [
  '/mnt/data/stacks/media/../../../etc/cron.d/pwn',
  '/mnt/data/stacks/media/x.conf; touch /tmp/pwned',
  '/mnt/data/stacks/media/$(id)',
  '/mnt/data/stacks/media/`id`',
  '/mnt/data/stacks/media/a b.conf',
  'relative/path.conf',
  '/mnt/data/stacks/media/',
  '/mnt/data/stacks/media/x.conf\nrm -rf /',
];

// Well-formed absolute paths that simply are not this deploy's business —
// refused by the containment rule, not the character class.
const OUT_OF_SCOPE_EXTRA_FILE_PATHS = [
  '/etc/cron.d/pwn',
  '/home/core/.config/containers/systemd/evil.container',
  '/mnt/data/stacks/other-service/config.yml',
  '/mnt/data/stacks/media.evil/config.yml',
  '/usr/local/bin/backdoor',
];

beforeEach(() => {
  for (const fn of Object.values(serviceManagerMock)) fn.mockClear();
});

describe('#2533 — MCP deploy_service rejects hostile yamlFileName', () => {
  for (const payload of HOSTILE_YAML_FILE_NAMES) {
    it(`refuses yamlFileName ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'deploy_service', {
        name: 'media',
        kubeContent: POD_YAML,
        yamlFileName: payload,
        node: 'local',
      });
      expect(rejected, `deploy_service accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/invalid file name|parent traversal|invalid arguments/);
      noDeployReached();
      await client.close();
    });
  }
});

describe('#2533 — MCP update_service_yaml rejects hostile yamlFileName', () => {
  for (const payload of HOSTILE_YAML_FILE_NAMES) {
    it(`refuses yamlFileName ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'update_service_yaml', {
        name: 'media',
        podSpecContent: POD_YAML,
        yamlFileName: payload,
        node: 'local',
      });
      expect(rejected, `update_service_yaml accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/invalid file name|parent traversal|invalid arguments/);
      noDeployReached();
      await client.close();
    });
  }
});

describe('#2533 — MCP update_service_yaml validates name with the shared ServiceName schema', () => {
  // The tool used to carry its own private `/^[a-zA-Z0-9_.-]+$/` copy. Both
  // patterns exclude `/`, so neither ever allowed traversal; the point of the
  // swap is that there is now ONE service-name rule to audit and tighten
  // instead of a copy that drifts from `ServiceName`.
  for (const payload of ['media/../../evil', 'media; id', 'media with spaces', 'media$(id)', 'media`id`', 'media|tee']) {
    it(`refuses name ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'update_service_yaml', {
        name: payload,
        podSpecContent: POD_YAML,
        node: 'local',
      });
      expect(rejected, `update_service_yaml accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/invalid service name|invalid arguments/);
      noDeployReached();
      await client.close();
    });
  }
});

describe('#2533 — MCP deploy_service rejects malformed extraFiles paths at the schema', () => {
  for (const payload of MALFORMED_EXTRA_FILE_PATHS) {
    it(`refuses extraFiles path ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'deploy_service', {
        name: 'media',
        kubeContent: POD_YAML,
        extraFiles: [{ path: payload, content: 'pwn' }],
        node: 'local',
      });
      expect(rejected, `deploy_service accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/absolute path|parent traversal|name a file|invalid arguments/);
      noDeployReached();
      await client.close();
    });
  }
});

describe('#2533 — MCP deploy_service contains extraFiles to the deploy own scope', () => {
  for (const payload of OUT_OF_SCOPE_EXTRA_FILE_PATHS) {
    it(`refuses out-of-scope extraFiles path ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'deploy_service', {
        name: 'media',
        kubeContent: POD_YAML,
        extraFiles: [{ path: payload, content: 'pwn' }],
        node: 'local',
      });
      expect(rejected, `deploy_service accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message).toMatch(/outside the service scope/);
      expect(message).toContain(payload);
      noDeployReached();
      await client.close();
    });
  }

  it('refuses the whole call when only ONE of several files is out of scope', async () => {
    const { client } = await connectClient();
    const { rejected } = await callExpectingRejection(client, 'deploy_service', {
      name: 'media',
      kubeContent: POD_YAML,
      extraFiles: [
        { path: '/mnt/data/stacks/media/config/nginx.conf', content: 'ok' },
        { path: '/etc/cron.d/pwn', content: 'pwn' },
      ],
      node: 'local',
    });
    expect(rejected).toBe(true);
    noDeployReached();
    await client.close();
  });
});

describe('#2533 — legitimate MCP deploys still work', () => {
  it('deploy_service writes companion files under a declared hostPath and the service data dir', async () => {
    const { client } = await connectClient();
    const extraFiles = [
      { path: '/mnt/data/stacks/media/config/nginx.conf', content: 'server {}' },
      { path: '/mnt/data/stacks/media/assets/logo.png', content: 'binary-ish' },
    ];
    const res = await client.callTool({
      name: 'deploy_service',
      arguments: { name: 'media', kubeContent: POD_YAML, yamlFileName: 'media.yml', extraFiles, node: 'local' },
    });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.deployKubeService).toHaveBeenCalledWith(
      'local',
      'media',
      expect.stringContaining('Yaml=media.yml'),
      POD_YAML,
      'media.yml',
      extraFiles,
    );
    await client.close();
  });

  it('deploy_service without extraFiles defaults the companion filename to <name>.yml', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'deploy_service',
      arguments: { name: 'media', kubeContent: POD_YAML, node: 'local' },
    });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.deployKubeService).toHaveBeenCalledWith(
      'local', 'media', expect.stringContaining('Yaml=media.yml'), POD_YAML, 'media.yml', undefined,
    );
    await client.close();
  });

  it('update_service_yaml still redeploys a normal pod spec', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { name: 'media', podSpecContent: POD_YAML, yamlFileName: 'media.yml', node: 'local' },
    });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.deployKubeService).toHaveBeenCalledWith(
      'local', 'media', expect.stringContaining('Yaml=media.yml'), POD_YAML, 'media.yml',
    );
    await client.close();
  });

  it('accepts the systemd-legal service-name characters ServiceName allows', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { name: 'sb-agent@core', podSpecContent: POD_YAML, node: 'local' },
    });
    expect(res.isError).toBeFalsy();
    expect(serviceManagerMock.deployKubeService).toHaveBeenCalled();
    await client.close();
  });
});
