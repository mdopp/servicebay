import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JAIL_ROOT } from './pathJail';

// #2140/#2141/#2142 — MCP proxy/install write tools:
//   write_file        — jailed writer (parent-dir create + core:core chown)
//   create_proxy_route— full NPM host via the install-runner POST endpoint
//   get_proxy_routes  — now surfaces NPM's live nginx_online/nginx_err
//   install_template  — wraps assembleManifest→createJob→startJob
//   get_install_progress — polls a job's phase/logs/deployed names
// These tests assert registration + scope + behaviour, mocking the box
// executor, the loopback fetch, and the install lib like readTools.test.ts.

// server.ts pulls in systemBackup → ssh2, whose poly1305 WASM init fires an
// async rejection under vitest ("Cannot read properties of undefined (reading
// 'then')") that fails the run even though every assertion passes. We never
// exercise ssh2 here, so stub it to a no-op Client (same pattern as
// nasClient.test.ts) to keep the import graph inert.
vi.mock('ssh2', () => ({ Client: vi.fn(function () { return { on() {}, connect() {}, end() {} }; }) }));

// --- Agent executor mock (write_file drives the box through it) ---
const execSafe = vi.fn();
const writeFile = vi.fn();
vi.mock('@/lib/agent/executor', () => ({
  AgentExecutor: class {
    execSafe(...a: unknown[]) { return execSafe(...a); }
    writeFile(...a: unknown[]) { return writeFile(...a); }
  },
}));

// Keep the safety gate permissive; spy the snapshot to assert write_file /
// create_proxy_route / install_template do NOT snapshot (all additive).
const snapshotBeforeMutation = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./safety', () => ({
  guardMutation: vi.fn(async () => null),
  guardExec: vi.fn(async () => null),
  snapshotBeforeMutation: (...a: unknown[]) => snapshotBeforeMutation(...a),
}));

vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn(async () => [{ Name: 'box', URI: '', Default: true }]),
  getNodeConnection: vi.fn(),
}));

vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'internal-test-token'),
}));

// --- Install lib mocks (#2141) ---
const assembleManifest = vi.fn(async () => ({
  items: [{ name: 'vaultwarden', checked: true }],
  variables: [{ name: 'X', value: '1' }],
}));
const applyVariableDefaults = vi.fn(async (input: unknown) => input);
vi.mock('@/lib/install/manifestAssembler', () => ({
  assembleManifest: (...a: unknown[]) => assembleManifest(...(a as [])),
  applyVariableDefaults: (...a: unknown[]) => applyVariableDefaults(...(a as [never])),
}));

const createJob = vi.fn(async () => ({ id: 'job-123', phase: 'running' }));
const getJob = vi.fn();
const readLog = vi.fn(async () => ({ content: 'deploying…', nextOffset: 42 }));
const getCurrentJob = vi.fn(async (): Promise<{ id: string; phase: string } | null> => null);
const startJob = vi.fn();
class InstallInProgressError extends Error {
  existingJobId: string;
  constructor(id: string) { super('in progress'); this.existingJobId = id; }
}
vi.mock('@/lib/install/jobStore', () => ({
  createJob: (...a: unknown[]) => createJob(...(a as [])),
  getJob: (...a: unknown[]) => getJob(...(a as [string])),
  readLog: (...a: unknown[]) => readLog(...(a as [])),
  getCurrentJob: (...a: unknown[]) => getCurrentJob(...(a as [])),
  InstallInProgressError,
}));
vi.mock('@/lib/install/runner', () => ({
  startJob: (...a: unknown[]) => startJob(...(a as [string])),
}));

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

const fetchMock = vi.fn();

beforeEach(() => {
  execSafe.mockReset();
  writeFile.mockReset();
  snapshotBeforeMutation.mockReset();
  assembleManifest.mockClear();
  applyVariableDefaults.mockClear();
  createJob.mockClear();
  getJob.mockReset();
  readLog.mockClear();
  getCurrentJob.mockReset();
  getCurrentJob.mockResolvedValue(null);
  startJob.mockReset();
  fetchMock.mockReset();
  // realpath (jail guard) + mkdir + chown all succeed by default.
  execSafe.mockImplementation(async (argv: string[]) => {
    if (argv[0] === 'realpath') return { stdout: argv[argv.length - 1], stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  writeFile.mockResolvedValue(undefined);
  // Fresh Response per call (memory: vitest fetch mocks reuse bodies).
  vi.stubGlobal('fetch', fetchMock);
});

describe('scope registration (#2140/#2141/#2142)', () => {
  it('registers the new tools at the right scopes', async () => {
    const { TOOL_SCOPES } = await import('./server');
    expect(TOOL_SCOPES.write_file).toBe('mutate');
    expect(TOOL_SCOPES.create_proxy_route).toBe('mutate');
    expect(TOOL_SCOPES.install_template).toBe('mutate');
    expect(TOOL_SCOPES.get_install_progress).toBe('read');
  });

  it('lists all five via the tools/list handshake', async () => {
    const { client } = await connectClient();
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['write_file', 'create_proxy_route', 'get_proxy_routes', 'install_template', 'get_install_progress']) {
      expect(names, `${n} must be registered`).toContain(n);
    }
    await client.close();
  });
});

describe('write_file (#2142)', () => {
  it('creates the parent dir, writes, chowns core:core, never snapshots', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'write_file',
      arguments: { path: 'local-templates/templates/tor/template.yml', content: 'name: tor' },
    });
    expect(res.isError).toBeFalsy();
    // realpath escape guard ran on the target.
    expect(execSafe).toHaveBeenCalledWith(
      expect.arrayContaining(['realpath', '-m', '--', `${JAIL_ROOT}/local-templates/templates/tor/template.yml`]),
    );
    // parent-dir create (sudo) on the file's parent.
    expect(execSafe).toHaveBeenCalledWith(
      ['mkdir', '-p', '--', `${JAIL_ROOT}/local-templates/templates/tor`],
      { sudo: true },
    );
    expect(writeFile).toHaveBeenCalledWith(`${JAIL_ROOT}/local-templates/templates/tor/template.yml`, 'name: tor');
    // core:core ownership (sudo).
    expect(execSafe).toHaveBeenCalledWith(
      ['chown', 'core:core', '--', `${JAIL_ROOT}/local-templates/templates/tor/template.yml`],
      { sudo: true },
    );
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects a `..`-escape before touching the box', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'write_file', arguments: { path: '../../etc/cron.d/x', content: 'evil' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/escapes the allowed root/);
    expect(writeFile).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects a symlink resolving out of the jail', async () => {
    execSafe.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'realpath') {
        const target = argv[argv.length - 1];
        if (target === JAIL_ROOT) return { stdout: JAIL_ROOT, stderr: '', code: 0 };
        return { stdout: '/etc/passwd', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'write_file', arguments: { path: 'evil-link', content: 'x' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/symlink/);
    expect(writeFile).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('create_proxy_route (#2140)', () => {
  it('POSTs a public forward-auth host to the install-runner endpoint with the internal token', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ created: ['tor.dopp.cloud'], failed: [], certs: [{ domain: 'tor.dopp.cloud', issued: true }], lanRestricted: [] }), { status: 200 }),
    );
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'create_proxy_route',
      arguments: { domain: 'tor.dopp.cloud', forwardPort: 8080, exposure: 'public', forwardAuth: true },
    });
    expect(res.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/system\/nginx\/proxy-hosts$/);
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('x-sb-internal-token')).toBe('internal-test-token');
    const sent = JSON.parse((init as RequestInit).body as string);
    // exposure forwarded + forward-auth expressed via the sentinel (route expands it).
    expect(sent.hosts[0].exposure).toBe('public');
    expect(sent.hosts[0].proxyConfig.advanced_config).toBe('__authelia_forward_auth__');
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/"created": true/);
    expect(text).toMatch(/"issued": true/);
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses forward-auth on a lan host (no https)', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'create_proxy_route',
      arguments: { domain: 'x.home.arpa', forwardPort: 80, exposure: 'lan', forwardAuth: true },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/forwardAuth requires exposure/);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
  });

  it('surfaces an NPM per-host failure as an error', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ created: [], failed: [{ domain: 'tor.dopp.cloud', error: 'duplicate location' }] }), { status: 200 }),
    );
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'create_proxy_route',
      arguments: { domain: 'tor.dopp.cloud', forwardPort: 8080, exposure: 'public' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/duplicate location/);
    await client.close();
  });
});

describe('get_proxy_routes live status (#2140)', () => {
  it('folds NPM nginx_online/nginx_err into the result', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ node: 'box', hosts: [{ domain: 'tor.dopp.cloud', nginx_online: false, nginx_err: '[emerg] duplicate location' }] }), { status: 200 }),
    );
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'get_proxy_routes', arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/"nginx_online": false/);
    expect(text).toMatch(/duplicate location/);
    await client.close();
  });

  it('still returns proxyState when the live NPM query fails', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 502 }));
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'get_proxy_routes', arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/proxyState/);
    expect(text).toMatch(/liveStatusError/);
    await client.close();
  });
});

describe('install_template (#2141)', () => {
  it('assembles, applies defaults, creates + starts the job, returns jobId', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'install_template',
      arguments: { names: ['vaultwarden'], variables: { SUBDOMAIN: 'vault' } },
    });
    expect(res.isError).toBeFalsy();
    expect(assembleManifest).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ name: 'vaultwarden', checked: true }],
      prefilled: { SUBDOMAIN: 'vault' },
    }));
    expect(applyVariableDefaults).toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'mcp' }));
    expect(startJob).toHaveBeenCalledWith('job-123');
    expect((res.content as { text: string }[])[0].text).toMatch(/"jobId": "job-123"/);
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses when an install job is already active', async () => {
    getCurrentJob.mockResolvedValue({ id: 'job-999', phase: 'running' });
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'install_template', arguments: { names: ['x'] } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/already in progress/);
    expect(createJob).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('get_install_progress (#2141)', () => {
  it('returns phase, deployed names, logs + offset', async () => {
    getJob.mockResolvedValue({
      id: 'job-123', phase: 'done', startedAt: 't0', updatedAt: 't1', endedAt: 't2',
      progress: { currentItem: null, deployedNames: ['vaultwarden'], totalCount: 1 },
    });
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'get_install_progress', arguments: { jobId: 'job-123' } });
    expect(res.isError).toBeFalsy();
    expect(readLog).toHaveBeenCalledWith('job-123', undefined);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/"phase": "done"/);
    expect(text).toMatch(/"active": false/);
    expect(text).toMatch(/vaultwarden/);
    expect(text).toMatch(/"logsOffset": 42/);
    await client.close();
  });

  it('errors on an unknown jobId', async () => {
    getJob.mockResolvedValue(null);
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'get_install_progress', arguments: { jobId: 'nope' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No install job found/);
    await client.close();
  });
});
