/**
 * ONE MCP tool for claude-dev projects — create / restart / delete (#2714).
 *
 * The operator asked for "a tool for creating/deleting/restarting projects —
 * ONE tool, not 3", and the parenthesis is the requirement. The count itself is
 * pinned next to the registry
 * (`packages/backend/src/lib/mcp/server.toolRegistry.test.ts`: the surface grew
 * by exactly one, and exactly one registered tool has "project" in its name).
 * What this file proves is everything the count cannot:
 *
 *   1. IT CALLS THE UI'S MECHANICS, NOT A SECOND COPY. The tool is driven
 *      against a REAL `createConfigUiServer` from
 *      `templates/claude-dev/config-ui/server.mjs`, standing on a miniature
 *      container (a workspace of checkouts, a tmux window list, a `~/.claude.json`,
 *      the container CLIs as fakes that really mutate that state) and on the REAL
 *      ServiceBay token store. A parallel implementation in the backend would
 *      pass none of these — nothing here would be wired at all.
 *
 *   2. A DELETE HITS EXACTLY ITS OWN CHILD. Always TWO projects, because a
 *      revoke that takes out every child of the container's parent token passes
 *      any one-project test. The sibling's token has to still VERIFY afterwards,
 *      its MCP entry has to still be there, and its session has to still run.
 *
 *   3. A RESTART CONFIRMS AT THE SOURCE (#2682). `start-claude` exits 0 in cases
 *      where no window ends up running, so the test makes it do exactly that and
 *      requires the tool to report an ERROR. "Reported success while the session
 *      was not back" is the failure this whole path exists to prevent.
 *
 *   4. THE TMUX TARGET IS ANCHORED (#2682). tmux resolves a window name exactly
 *      and THEN by prefix, so an unanchored `claude:solaris` kills `solarisbay`
 *      and reports success. The fake tmux models that resolution, so a lost `=`
 *      shows up here as the sibling it took out.
 *
 *   5. THE SCOPE SPLIT IS BY REVERSIBILITY. `create`/`restart` are `lifecycle`;
 *      `delete` is `destroy` — it revokes a token and ends a session — so a
 *      lifecycle token is refused and a destroy token is parked for human
 *      approval instead of executing.
 *
 * Nothing here touches the real box: every project, session and token in this
 * file is this test's own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_MJS = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui', 'server.mjs');

// The real token store on a throwaway DATA_DIR — delegation and revocation are
// counted off the rows that were actually written.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

// The port the miniature container's UI really listens on this run. The tool
// resolves it through the shared read-path resolver, so a Template Setting is
// exactly how an operator would move it (#2544).
let configUiPort = 0;
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({
    mcp: { allowMutations: true },
    templateSettings: {
      CLAUDE_DEV_CONFIG_PORT: String(configUiPort),
      CLAUDE_DEV_LDAP_GROUP: 'admins',
    },
  })),
  updateConfig: vi.fn(),
}));

// Keep the MCP safety/audit tail inert — it is not what this file is about.
vi.mock('@/lib/mcp/safety', async (orig) => {
  const actual = await orig<typeof import('@/lib/mcp/safety')>();
  return { ...actual, snapshotBeforeMutation: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/mcp/audit', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/mcp/notify', () => ({ notifyDestructiveOp: vi.fn().mockResolvedValue(undefined) }));
const submitApproval = vi.fn(async (req: unknown) => {
  approvals.push(req as Record<string, unknown>);
  return { id: 'appr-1' };
});
const approvals: Record<string, unknown>[] = [];
vi.mock('@/lib/approvals', () => ({
  submitApproval: (req: unknown) => submitApproval(req),
  registerMcpDispatcher: vi.fn(),
  registerTokenMinter: vi.fn(),
}));
vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn(async () => [{ Name: 'Local' }]),
  getNodeConnection: vi.fn(),
}));

const loadTokens = () => import('@/lib/auth/apiTokens');

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

const failure = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });

type Harness = Awaited<ReturnType<typeof setup>>;

/**
 * A whole claude-dev container in miniature, plus the ServiceBay side of its
 * token delegation. Mirrors `claude_dev_project_crud.test.ts`'s harness — the
 * same container, reached through the MCP tool instead of the browser panel.
 */
async function setup() {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-cd-mcp-'));
  const tokens = await loadTokens();

  // The container's own read-only, non-expiring token (#2673) — the parent of
  // every project token below.
  const parent = await tokens.createToken({
    name: 'claude-dev', scopes: ['read'], neverExpires: true, createdBy: 'install',
  });

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-cd-mcp-ws-'));
  // A checkout somebody cloned by hand: nobody's to remove (#2713's case).
  fs.mkdirSync(path.join(workspace, 'handmade', '.git'), { recursive: true });
  const claudeJson = path.join(workspace, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    mcpServers: { servicebay: { type: 'http', url: 'http://host.containers.internal:5888/mcp' } },
    projects: {},
  }));
  const readJson = () => JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
  const writeJson = (v: unknown) => fs.writeFileSync(claudeJson, JSON.stringify(v));

  const state = {
    windows: ['handmade'] as string[],
    /** When set, `start-claude` exits 0 and starts nothing — the #2682 case. */
    startSilentlyDoesNothing: false,
  };

  // ── ServiceBay, standing on the real delegate/revoke route handlers ──
  const routes = await import('@/lib/api/apiTokenRoutes');
  const servicebay = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://servicebay.invalid');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname !== '/api/system/api-tokens/delegate') return send(404, { error: 'no such route' });
      const text = await readRequestBody(req);
      const asRequest = new Request(`http://servicebay.invalid${req.url}`, {
        method: req.method,
        headers: {
          authorization: String(req.headers.authorization ?? ''),
          'content-type': 'application/json',
        },
        ...(text ? { body: text } : {}),
      });
      const response = req.method === 'POST'
        ? await routes.delegateTokenHandler({ request: asRequest })
        : await routes.revokeDelegatedTokenHandler({
          request: asRequest,
          query: { id: url.searchParams.get('id') ?? undefined },
        });
      send(response.status, await response.json());
    })();
  });
  await new Promise<void>(r => servicebay.listen(0, '127.0.0.1', r));
  const servicebayUrl = `http://127.0.0.1:${(servicebay.address() as AddressInfo).port}`;

  // ── the container CLIs ──
  const runCommand = (file: string, args: string[], opts: { cwd?: string } = {}) => {
    if (file === 'git' && args[0] === 'clone') {
      fs.mkdirSync(path.join(args[3], '.git'), { recursive: true });
      return '';
    }
    if (file === 'git' && args[0] === 'config') return '';
    if (file === 'claude' && args[1] === 'add') {
      const [, , , , , , name, mcpUrl, , header] = args;
      const json = readJson();
      json.projects ??= {};
      json.projects[opts.cwd!] ??= {};
      json.projects[opts.cwd!].mcpServers ??= {};
      json.projects[opts.cwd!].mcpServers[name] = {
        type: 'http', url: mcpUrl, headers: { Authorization: header.replace(/^Authorization:\s*/, '') },
      };
      writeJson(json);
      return '';
    }
    if (file === 'claude' && args[1] === 'remove') {
      const json = readJson();
      const servers = json.projects?.[opts.cwd!]?.mcpServers;
      if (!servers?.[args[2]]) throw failure(`No MCP server found named: ${args[2]}`);
      delete servers[args[2]];
      writeJson(json);
      return '';
    }
    if (file === 'start-claude') {
      // Exits 0 either way — which is precisely why tmux, not this, is the
      // authority on whether a session came back.
      if (state.startSilentlyDoesNothing) return '';
      const name = args[args.length - 1];
      if (!state.windows.includes(name)) state.windows.push(name);
      return '';
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const runTmux = (args: string[]) => {
    if (args[0] === 'list-windows') return state.windows.join('\n') + '\n';
    if (args[0] === 'kill-window') {
      // Real tmux: `=name` matches EXACTLY, an unanchored name also matches by
      // PREFIX. Modelled, so a kill that lost its anchor takes out the sibling
      // here exactly as it would on the box.
      const target = String(args[2]).split(':')[1] ?? '';
      const name = target.startsWith('=')
        ? (state.windows.includes(target.slice(1)) ? target.slice(1) : '')
        : (state.windows.find(w => w === target) ?? state.windows.find(w => w.startsWith(target)) ?? '');
      const at = name ? state.windows.indexOf(name) : -1;
      if (at < 0) throw failure(`can't find window: ${target.replace(/^=/, '')}`);
      state.windows.splice(at, 1);
      return '';
    }
    throw new Error(`unexpected tmux ${args.join(' ')}`);
  };

  const mod = await import(/* @vite-ignore */ SERVER_MJS);
  const ui = mod.createConfigUiServer({
    requiredGroup: 'admins',
    servicebay: { url: servicebayUrl, token: parent.secret },
    projects: { devHome: workspace, homeDir: workspace, tmuxSession: 'claude', runTmux, runCommand },
    log: () => {},
  });
  await new Promise<void>(r => ui.listen(0, '127.0.0.1', r));
  configUiPort = (ui.address() as AddressInfo).port;

  return {
    tokens, parent, workspace, state, readJson,
    children: async () => (await tokens.listTokens()).filter(t => t.parentId === parent.token.id),
    /** The `sb_…` secret the container would really authenticate `name` with. */
    recordedSecret: (name: string) => {
      const entry = readJson().projects?.[path.join(workspace, name)]?.mcpServers?.servicebay;
      return String(entry?.headers?.Authorization ?? '').replace(/^Bearer\s+/, '');
    },
    close: async () => {
      await new Promise<void>(r => ui.close(() => r()));
      await new Promise<void>(r => servicebay.close(() => r()));
    },
  };
}

interface ToolCallResult { content?: { type: string; text?: string }[]; isError?: boolean }

/** Call the ONE tool over a real in-memory MCP transport. `auth` absent = the
 *  cookie/operator path, which executes inline; with `auth` the token gates
 *  (scope + destroy-tier approval) apply. */
async function callTool(
  args: Record<string, unknown>,
  auth?: { user: string; scopes: string[] },
): Promise<ToolCallResult> {
  const { createMcpServer } = await import('@/lib/mcp/server');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer(auth ? ({ auth } as any) : undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({
      name: 'manage_claude_dev_project',
      arguments: args,
    }) as ToolCallResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (res: ToolCallResult) => res.content?.map(c => c.text ?? '').join('\n') ?? '';
const jsonOf = (res: ToolCallResult) => JSON.parse(textOf(res));

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  approvals.length = 0;
  submitApproval.mockClear();
  h = await setup();
});

afterEach(async () => {
  await h.close();
  await (await loadTokens()).flushPendingStamps();
  await fsp.rm(h.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Two projects, always — see the file header, point 2. */
async function createTwo() {
  const alpha = await callTool({ action: 'create', gitUrl: 'https://github.com/mdopp/alpha.git' });
  const beta = await callTool({ action: 'create', gitUrl: 'https://github.com/mdopp/beta.git' });
  expect(alpha.isError, textOf(alpha)).toBeFalsy();
  expect(beta.isError, textOf(beta)).toBeFalsy();
  return { alpha: jsonOf(alpha), beta: jsonOf(beta) };
}

describe('manage_claude_dev_project — create (#2714)', () => {
  it('clones, delegates the project its OWN read-only token, wires MCP and starts the session', async () => {
    expect(await h.children()).toHaveLength(0);

    const res = await callTool({ action: 'create', gitUrl: 'https://github.com/mdopp/solarisbay.git' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const body = jsonOf(res);

    expect(body.project.name).toBe('solarisbay');
    expect(body.project.cloned).toBe(true);
    // Confirmed by asking tmux, not by trusting start-claude.
    expect(body.project.session).toEqual({ running: true });
    expect(h.state.windows).toContain('solarisbay');
    expect(fs.existsSync(path.join(h.workspace, 'solarisbay', '.git'))).toBe(true);

    // Its own child token — read off the row that was WRITTEN.
    const children = await h.children();
    expect(children).toHaveLength(1);
    expect(children[0].scopes).toEqual(['read']);
    expect(children[0].parentId).toBe(h.parent.token.id);

    // …and it is the credential the container would really present.
    const verified = await h.tokens.verifyToken(h.recordedSecret('solarisbay'));
    expect(verified?.id).toBe(children[0].id);
  });

  it('refuses a clone URL on an action that clones nothing, instead of ignoring it', async () => {
    const res = await callTool({ action: 'restart', name: 'handmade', gitUrl: 'https://github.com/mdopp/x.git' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('`gitUrl` applies only to action "create"');
    // Nothing was attempted: the session list is untouched.
    expect(h.state.windows).toEqual(['handmade']);
  });
});

describe('manage_claude_dev_project — delete hits exactly its own child (#2714)', () => {
  it('revokes ITS token and leaves the sibling\'s token, MCP entry and session intact', async () => {
    await createTwo();
    const betaSecret = h.recordedSecret('beta');
    const alphaSecret = h.recordedSecret('alpha');
    expect(await h.children()).toHaveLength(2);

    const res = await callTool({ action: 'delete', name: 'alpha' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const body = jsonOf(res);

    // It reports what happened rather than leaving the caller to infer it.
    expect(body.removed).toMatchObject({
      name: 'alpha', managed: true, tokenRevoked: true, mcpEntryRemoved: true, checkoutDeleted: false,
    });
    expect(body.removed.tokenId).toBeTruthy();

    // Exactly one child gone — the sibling's token still VERIFIES.
    expect(await h.children()).toHaveLength(1);
    expect(await h.tokens.verifyToken(alphaSecret)).toBeNull();
    const survivor = await h.tokens.verifyToken(betaSecret);
    expect(survivor?.scopes).toEqual(['read']);

    // The sibling's MCP entry and its session are untouched.
    expect(h.recordedSecret('beta')).toBe(betaSecret);
    expect(h.recordedSecret('alpha')).toBe('');
    expect(h.state.windows).toContain('beta');
    expect(h.state.windows).not.toContain('alpha');
    // …and so is the checkout nobody added.
    expect(h.state.windows).toContain('handmade');
  });

  it('meets #2713\'s guard rather than walking around it: an unmanaged checkout needs the acknowledgement', async () => {
    const refused = await callTool({ action: 'delete', name: 'handmade' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('was not added through this page');
    expect(h.state.windows).toContain('handmade');

    const done = await callTool({ action: 'delete', name: 'handmade', acknowledgeUnmanaged: true });
    expect(done.isError, textOf(done)).toBeFalsy();
    const body = jsonOf(done);
    // The honest half: session stopped and marked, nothing revoked.
    expect(body.removed).toMatchObject({ managed: false, tokenRevoked: false, mcpEntryRemoved: false });
    expect(h.state.windows).not.toContain('handmade');
  });

  it('leaves name validation to the ONE authority — a traversal name is refused, not encoded around', async () => {
    // The name becomes a path segment and a tmux window name inside the
    // container, and `validateProjectName` in server.mjs is the single place
    // that decides what is usable. The tool must carry the name there intact
    // (a query string that swallowed the `/` would be worse than useless) and
    // report the refusal it gets back.
    for (const name of ['../handmade', 'alpha; rm -rf /', 'a\nb']) {
      const res = await callTool({ action: 'delete', name });
      expect(res.isError, `${name} was not refused`).toBe(true);
      expect(textOf(res)).toContain('is not a usable project name');
    }
    expect(h.state.windows).toEqual(['handmade']);
  });

  it('fails loudly on a project that is not there — it does not quietly succeed', async () => {
    const res = await callTool({ action: 'delete', name: 'nosuchproject' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('there is no checkout named "nosuchproject"');
  });
});

describe('manage_claude_dev_project — restart confirms at the source (#2682)', () => {
  it('restarts exactly one session and leaves the siblings running', async () => {
    await createTwo();
    const res = await callTool({ action: 'restart', name: 'alpha' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const body = jsonOf(res);
    expect(body.restarted).toMatchObject({ name: 'alpha', wasRunning: true, session: { running: true } });
    // The siblings still up are reported, not promised.
    expect(body.restarted.others.sort()).toEqual(['beta', 'handmade']);
    expect(h.state.windows).toContain('beta');
  });

  it('reports an ERROR when start-claude exits 0 and the session does not come back', async () => {
    await createTwo();
    h.state.startSilentlyDoesNothing = true;

    const res = await callTool({ action: 'restart', name: 'alpha' });
    // The whole point: a zero exit code is not evidence. tmux is re-asked.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('has no tmux window after the restart');
    expect(h.state.windows).not.toContain('alpha');
    // And the sibling was not collateral.
    expect(h.state.windows).toContain('beta');
  });

  it('fails loudly against a project that has no checkout at all', async () => {
    const res = await callTool({ action: 'restart', name: 'nosuchproject' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('there is no checkout named "nosuchproject"');
  });

  it('anchors the tmux target, so a name that is a PREFIX of a live window cannot destroy it', async () => {
    // `solarisbay` is running; `solaris` is a checkout with no window. Unanchored,
    // tmux resolves `claude:solaris` to `solarisbay` — the kill would take out the
    // neighbour and the call would report success.
    await callTool({ action: 'create', gitUrl: 'https://github.com/mdopp/solarisbay.git' });
    fs.mkdirSync(path.join(h.workspace, 'solaris', '.git'), { recursive: true });
    expect(h.state.windows).toContain('solarisbay');

    const res = await callTool({ action: 'restart', name: 'solaris' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const body = jsonOf(res);
    // The neighbour survived, and the report says the target was started, not
    // restarted — it had no session of its own.
    expect(h.state.windows).toContain('solarisbay');
    expect(h.state.windows).toContain('solaris');
    expect(body.warnings.join(' ')).toContain('was STARTED rather than restarted');
  });
});

describe('manage_claude_dev_project — scope split by reversibility (#2714)', () => {
  it('lets a lifecycle token restart, and refuses it the delete', async () => {
    await createTwo();
    const lifecycle = { user: 'agent', scopes: ['lifecycle'] };

    const restarted = await callTool({ action: 'restart', name: 'alpha' }, lifecycle);
    expect(restarted.isError, textOf(restarted)).toBeFalsy();

    const refused = await callTool({ action: 'delete', name: 'alpha' }, lifecycle);
    expect(refused.isError).toBe(true);
    // The message names the scope THAT ACTION needs, not the tool's floor.
    expect(textOf(refused)).toContain("Token scope 'destroy' required");
    // Nothing was revoked and nothing was stopped.
    expect(await h.children()).toHaveLength(2);
    expect(h.state.windows).toContain('alpha');
  });

  it('parks a destroy-token delete for human approval instead of running it', async () => {
    await createTwo();
    const res = await callTool({ action: 'delete', name: 'alpha' }, { user: 'agent', scopes: ['destroy'] });

    expect(textOf(res)).toContain('pending_approval');
    expect(submitApproval).toHaveBeenCalledTimes(1);
    expect(approvals[0]).toMatchObject({ service: 'alpha' });
    // Proposed, not done: both tokens and both sessions are still there.
    expect(await h.children()).toHaveLength(2);
    expect(h.state.windows).toContain('alpha');
  });

  it('does not park a create or a restart — they are lifecycle verbs', async () => {
    const created = await callTool(
      { action: 'create', gitUrl: 'https://github.com/mdopp/alpha.git' },
      { user: 'agent', scopes: ['lifecycle'] },
    );
    expect(created.isError, textOf(created)).toBeFalsy();
    expect(submitApproval).not.toHaveBeenCalled();
  });
});

describe('manage_claude_dev_project — when the container is not there', () => {
  it('says the configuration UI is unreachable rather than reporting a clean no-op', async () => {
    await h.close();
    const res = await callTool({ action: 'restart', name: 'handmade' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not reachable');
  });
});
