import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JAIL_ROOT } from './pathJail';

// #1872: typed non-destructive MCP read tools (read_file/list_dir/disk_usage/
// container_exec). These tests assert: all four are registered + callable;
// read_file/list_dir reject a path-escape; container_exec passes an argv array
// (no shell); disk_usage delegates to the disk probe's single du source; and
// crucially that NONE of them trigger snapshotBeforeMutation (non-destructive).

// Mock the agent executor — every read tool drives the box through it.
const execSafe = vi.fn();
const execArgv = vi.fn();
const readFile = vi.fn();
vi.mock('@/lib/agent/executor', () => ({
  AgentExecutor: class {
    execSafe(...a: unknown[]) { return execSafe(...a); }
    execArgv(...a: unknown[]) { return execArgv(...a); }
    readFile(...a: unknown[]) { return readFile(...a); }
  },
}));

// Spy snapshotBeforeMutation while keeping the real gate helpers permissive.
const snapshotBeforeMutation = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./safety', () => ({
  guardMutation: vi.fn(async () => null),
  guardExec: vi.fn(async () => null),
  snapshotBeforeMutation: (...a: unknown[]) => snapshotBeforeMutation(...a),
}));

// disk_usage must REUSE the disk probe's du helper, not reimplement du.
const largestDirsUnderDataDir = vi.fn(async (..._a: unknown[]) => '1.2G\t/mnt/data/media\n300M\t/mnt/data/backups');
vi.mock('@/lib/diagnose/probes/disk', () => ({
  largestDirsUnderDataDir: (...a: unknown[]) => largestDirsUnderDataDir(...a),
}));

// resolveNode calls listNodes; give it one node so we don't need a real store.
vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn(async () => [{ Name: 'box', URI: '', Default: true }]),
  getNodeConnection: vi.fn(),
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

beforeEach(() => {
  execSafe.mockReset();
  execArgv.mockReset();
  readFile.mockReset();
  snapshotBeforeMutation.mockReset();
  largestDirsUnderDataDir.mockClear();
  // Default realpath/stat: identity inside the jail, regular file.
  execSafe.mockImplementation(async (argv: string[]) => {
    const cmd = argv[0];
    if (cmd === 'realpath') return { stdout: argv[argv.length - 1], stderr: '', code: 0 };
    if (cmd === 'stat') return { stdout: 'regular 42', stderr: '', code: 0 };
    if (cmd === 'find') return { stdout: 'f\t10\t1700000000\ta.txt\nd\t4096\t1700000001\tsub', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  readFile.mockResolvedValue('hello world');
  execArgv.mockResolvedValue({ stdout: 'NAME=fedora', stderr: '' });
});

describe('read tools registration (#1872)', () => {
  it('registers all four tools at the read/exec scopes (none destructive)', async () => {
    const { TOOL_SCOPES } = await import('./server');
    expect(TOOL_SCOPES.read_file).toBe('read');
    expect(TOOL_SCOPES.list_dir).toBe('read');
    expect(TOOL_SCOPES.disk_usage).toBe('read');
    expect(TOOL_SCOPES.container_exec).toBe('exec');
  });

  it('lists all four via the MCP tools/list handshake', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const n of ['read_file', 'list_dir', 'disk_usage', 'container_exec']) {
      expect(names, `${n} must be registered`).toContain(n);
    }
    await client.close();
  });
});

describe('read_file (#1872)', () => {
  it('reads a jailed file and never snapshots', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'read_file', arguments: { path: 'stacks/auth/config.yml' } });
    expect(res.isError).toBeFalsy();
    expect(readFile).toHaveBeenCalledWith(`${JAIL_ROOT}/stacks/auth/config.yml`);
    // The symlink-escape guard runs `realpath` via safe_exec — `realpath` MUST
    // be on the agent SAFE_EXEC_ALLOWLIST or this crashes on the box (#1872
    // box-verify RED). Assert the call shape so a regression that drops the
    // realpath safe_exec (or routes it through a non-allowlisted path) is caught.
    expect(execSafe).toHaveBeenCalledWith(
      expect.arrayContaining(['realpath', '-m', '--', `${JAIL_ROOT}/stacks/auth/config.yml`]),
    );
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects a `..`-escape before touching the agent', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/escapes the allowed root/);
    expect(readFile).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects a symlink that resolves out of the jail (server-side realpath)', async () => {
    execSafe.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'realpath') {
        // The jail-root resolve must still land on the root (FCoS resolves
        // /mnt/data -> itself here); only the symlinked target escapes.
        const target = argv[argv.length - 1];
        if (target === JAIL_ROOT) return { stdout: JAIL_ROOT, stderr: '', code: 0 };
        return { stdout: '/etc/shadow', stderr: '', code: 0 };
      }
      return { stdout: 'regular 42', stderr: '', code: 0 };
    });
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'read_file', arguments: { path: 'evil-link' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/symlink/);
    expect(readFile).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('list_dir (#1872)', () => {
  it('lists entries with type/size/mtime and never snapshots', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'list_dir', arguments: { path: 'stacks' } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/"name": "a.txt"/);
    expect(text).toMatch(/"type": "file"/);
    expect(text).toMatch(/"type": "dir"/);
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects an absolute-escape path', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'list_dir', arguments: { path: '/etc' } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});

describe('disk_usage (#1872)', () => {
  it('reuses the disk probe du helper (no duplicate du) and never snapshots', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'disk_usage', arguments: { top: 5 } });
    expect(res.isError).toBeFalsy();
    expect(largestDirsUnderDataDir).toHaveBeenCalledWith('box', 5);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/\/mnt\/data\/media/);
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('container_exec (#1872)', () => {
  it('runs `podman exec` via safe_exec and returns the real stdout', async () => {
    // Regression guard for the box-verify RED: container_exec used execArgv,
    // whose legacy-exec trace wrapper (`: # SB_TRACE=…; <cmd>`) commented the
    // command out and always returned empty stdout. It must use execSafe
    // (safe_exec, `podman` allowlisted) and surface the container's output.
    execSafe.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'podman') return { stdout: 'NAME=fedora\nID=fedora', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'container_exec',
      arguments: { container: 'media-jellyfin', args: ['cat', '/etc/os-release'] },
    });
    expect(res.isError).toBeFalsy();
    expect(execSafe).toHaveBeenCalledWith(['podman', 'exec', 'media-jellyfin', 'cat', '/etc/os-release']);
    // NOT the broken legacy-exec path.
    expect(execArgv).not.toHaveBeenCalled();
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toMatch(/NAME=fedora/);
    expect(snapshotBeforeMutation).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects an invalid container name via the schema', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'container_exec',
      arguments: { container: 'bad; rm -rf /', args: ['ls'] },
    });
    expect(res.isError).toBe(true);
    expect(execSafe).not.toHaveBeenCalled();
    expect(execArgv).not.toHaveBeenCalled();
    await client.close();
  });
});
