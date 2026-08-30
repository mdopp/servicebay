/**
 * claude-dev config UI — the PROJECT LIST panel (#2679, epic #2674).
 *
 * Acceptance on the issue:
 *   1. the panel lists every existing `/workspace/<name>` checkout on the box;
 *   2. each row shows session-running yes/no and MCP-entry-present yes/no,
 *      matching the actual on-disk / process state;
 *   3. no SSH needed — it is visible from the UI shell alone.
 *
 * The criterion that rots silently here is not the happy path. A list that
 * renders nothing because the workspace is empty and a list that renders
 * nothing because the READ BROKE look identical on screen, and a happy-path
 * test cannot tell them apart either. So every "nothing" below is asserted as
 * a specific, named nothing:
 *
 *   • empty workspace     → HTTP 200, `projects: []`, `sources.checkouts.ok`
 *                           true, and the panel shows `.projects-empty`;
 *   • checkout read fails → HTTP 500 with an error and NO `projects` key at
 *                           all, and the panel shows `.projects-error`;
 *   • one source fails    → rows still render, that column is "Unknown"
 *                           (`session: null`, never `{running:false}`) and a
 *                           `.projects-source-warning` names the failure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_UI_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui');
const SERVER_MJS = path.join(CONFIG_UI_DIR, 'server.mjs');
const PANEL_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'projects.js');
const MANIFEST_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'index.js');
const SHELL_JS = path.join(CONFIG_UI_DIR, 'public', 'shell.js');

const ADMIN = { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' };
const FAKE_TOKEN = 'sb_projects_test_token_never_leaves_the_server';

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(port: number, pathname: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A throwaway /workspace that mirrors what the box actually looks like:
 * development checkouts, a content checkout with no CLAUDE.md, a worktree
 * whose `.git` is a FILE, and a plain directory that is not a checkout at all.
 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dev-projects-'));
  const checkout = (name: string, opts: { claudeMd?: boolean; gitFile?: boolean } = {}) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (opts.gitFile) fs.writeFileSync(path.join(dir, name, '.git'), 'gitdir: /elsewhere\n');
    else fs.mkdirSync(path.join(dir, name, '.git'));
    if (opts.claudeMd !== false) fs.writeFileSync(path.join(dir, name, 'CLAUDE.md'), '# notes\n');
  };
  checkout('servicebay');
  checkout('solarisbay');
  checkout('servicebay-templates', { claudeMd: false });
  checkout('usage-metrics', { gitFile: true });
  // Not checkouts: the per-user homes and a hidden dir the entrypoint's `*/`
  // glob also skips.
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ssh'), { recursive: true });
  return dir;
}

function writeClaudeJson(dir: string, body: unknown) {
  fs.writeFileSync(path.join(dir, '.claude.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

async function startServer(projects: Record<string, unknown>) {
  const mod = await import(/* @vite-ignore */ SERVER_MJS);
  const server = mod.createConfigUiServer({
    requiredGroup: 'admins',
    servicebay: { url: 'http://host.containers.internal:5888', token: FAKE_TOKEN },
    projects,
    log: () => {},
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

// ───────────────────────────── the server read ──────────────────────────────

describe('claude-dev config UI: GET /api/projects reads the real container state', () => {
  let workspace = '';
  let server: http.Server;
  let port = 0;
  // The tmux windows this run pretends exist. Reassigned per test.
  let windows: string[] = [];
  let tmuxFails: Error | null = null;

  beforeAll(async () => {
    workspace = makeWorkspace();
    writeClaudeJson(workspace, {
      mcpServers: { 'atHome-Servicebay': { type: 'http' } },
      projects: {
        [path.join(workspace, 'solarisbay')]: { mcpServers: { 'atHome-Servicebay': { type: 'http' } } },
      },
    });
    ({ server, port } = await startServer({
      devHome: workspace,
      homeDir: workspace,
      tmuxSession: 'claude',
      runTmux: (args: string[]) => {
        expect(args).toEqual(['list-windows', '-t', 'claude', '-F', '#W']);
        if (tmuxFails) throw tmuxFails;
        return windows.join('\n') + '\n';
      },
    }));
  });

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => { windows = ['servicebay', 'solarisbay', 'usage-metrics']; tmuxFails = null; });

  it('is behind the same auth gate as everything else — anonymous leaks no list', async () => {
    const res = await request(port, '/api/projects');
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('servicebay');
  });

  it('lists every git checkout under the workspace and nothing else (acceptance 1)', async () => {
    const res = await request(port, '/api/projects', ADMIN);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.projects.map((p: { name: string }) => p.name))
      .toEqual(['servicebay', 'servicebay-templates', 'solarisbay', 'usage-metrics']);
    // `home/` and `.ssh/` are not checkouts; a `.git` FILE (worktree) is one.
    expect(body.projects.map((p: { name: string }) => p.name)).not.toContain('home');
    expect(body.projects.find((p: { name: string }) => p.name === 'usage-metrics')).toBeTruthy();
    expect(body.workspace).toBe(workspace);
    expect(body.sources.checkouts.ok).toBe(true);
  });

  it('reports session-running per checkout, matching the tmux windows (acceptance 2)', async () => {
    const res = await request(port, '/api/projects', ADMIN);
    const byName = Object.fromEntries(
      JSON.parse(res.body).projects.map((p: { name: string }) => [p.name, p]),
    );
    expect(byName['servicebay'].session).toEqual({ running: true });
    expect(byName['solarisbay'].session).toEqual({ running: true });
    // No CLAUDE.md → the entrypoint never auto-starts it, so a real "no".
    expect(byName['servicebay-templates'].session).toEqual({ running: false });
    expect(byName['servicebay-templates'].developmentTarget).toBe(false);
    expect(byName['servicebay'].developmentTarget).toBe(true);
  });

  it('reports MCP-entry-present per checkout, with the scope it came from (acceptance 2)', async () => {
    const res = await request(port, '/api/projects', ADMIN);
    const byName = Object.fromEntries(
      JSON.parse(res.body).projects.map((p: { name: string }) => [p.name, p]),
    );
    // The entrypoint writes ONE user-scope entry, inherited by every checkout.
    expect(byName['servicebay'].mcp).toEqual({
      configured: true, scopes: ['user'], servers: ['atHome-Servicebay'],
    });
    // solarisbay additionally carries a local-scope entry for the same server.
    expect(byName['solarisbay'].mcp.scopes).toEqual(['user', 'local']);
    expect(byName['solarisbay'].mcp.servers).toEqual(['atHome-Servicebay']);
  });

  it('sees a PROJECT-scope .mcp.json inside the checkout', async () => {
    const file = path.join(workspace, 'servicebay', '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'project-only': { type: 'stdio' } } }));
    try {
      const res = await request(port, '/api/projects', ADMIN);
      const sb = JSON.parse(res.body).projects.find((p: { name: string }) => p.name === 'servicebay');
      expect(sb.mcp.scopes).toEqual(['user', 'project']);
      expect(sb.mcp.servers).toEqual(['atHome-Servicebay', 'project-only']);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('an empty tmux server is a real "nothing is running", not a failed read', async () => {
    // This is what `tmux list-windows` prints when no session exists at all.
    tmuxFails = Object.assign(new Error('Command failed'), { stderr: 'no server running on /tmp/tmux-1000/default' });
    const res = await request(port, '/api/projects', ADMIN);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.sources.sessions.ok).toBe(true);
    for (const p of body.projects) expect(p.session).toEqual({ running: false });
  });

  it('a FAILED session read reports Unknown, never "not running"', async () => {
    tmuxFails = Object.assign(new Error('spawnSync tmux ENOENT'), { stderr: '' });
    const res = await request(port, '/api/projects', ADMIN);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.sources.sessions.ok).toBe(false);
    expect(body.sources.sessions.error).toContain('ENOENT');
    // The whole point: unknown, not false. A false here would claim every
    // session is dead on the strength of a broken read.
    for (const p of body.projects) expect(p.session).toBeNull();
    // The other sources still answered, so their columns are still real.
    expect(body.sources.mcp.ok).toBe(true);
    expect(body.projects[0].mcp.configured).toBe(true);
  });

  it('never discloses the ServiceBay token through this route', async () => {
    const res = await request(port, '/api/projects', ADMIN);
    expect(res.body).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(FAKE_TOKEN);
  });
});

describe('claude-dev config UI: /api/projects tells "empty" apart from "broken"', () => {
  const servers: http.Server[] = [];
  const dirs: string[] = [];

  afterAll(async () => {
    for (const s of servers) await new Promise<void>(r => s.close(() => r()));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('an EMPTY workspace answers 200 with an explicitly successful empty list', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dev-empty-'));
    dirs.push(empty);
    const { server, port } = await startServer({ devHome: empty, homeDir: empty, runTmux: () => '' });
    servers.push(server);

    const res = await request(port, '/api/projects', ADMIN);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.projects).toEqual([]);
    // The list is empty BECAUSE the read succeeded and found nothing — that
    // assertion is what separates this case from the one below.
    expect(body.sources.checkouts.ok).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it('an UNREADABLE workspace answers 500 with an error — never an empty list', async () => {
    const gone = path.join(os.tmpdir(), 'claude-dev-does-not-exist-' + Date.now());
    const { server, port } = await startServer({ devHome: gone, homeDir: gone, runTmux: () => '' });
    servers.push(server);

    const res = await request(port, '/api/projects', ADMIN);
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain(gone);
    // No empty array to mistake for "there is nothing here".
    expect(body.projects).toBeUndefined();
  });

  it('a malformed ~/.claude.json makes the MCP column Unknown, not "None"', async () => {
    const dir = makeWorkspace();
    dirs.push(dir);
    writeClaudeJson(dir, '{ this is not json');
    const { server, port } = await startServer({ devHome: dir, homeDir: dir, runTmux: () => 'servicebay\n' });
    servers.push(server);

    const res = await request(port, '/api/projects', ADMIN);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources.mcp.ok).toBe(false);
    expect(body.sources.mcp.error).toContain('not valid JSON');
    for (const p of body.projects) expect(p.mcp).toBeNull();
    // Sessions were readable, so they are still reported for real.
    expect(body.sources.sessions.ok).toBe(true);
    expect(body.projects.find((p: { name: string }) => p.name === 'servicebay').session).toEqual({ running: true });
  });

  it('a workspace with no ~/.claude.json at all reports "none configured", which is a real answer', async () => {
    const dir = makeWorkspace();
    dirs.push(dir);
    const { server, port } = await startServer({ devHome: dir, homeDir: dir, runTmux: () => '' });
    servers.push(server);

    const body = JSON.parse((await request(port, '/api/projects', ADMIN)).body);
    expect(body.sources.mcp.ok).toBe(true);
    for (const p of body.projects) expect(p.mcp).toEqual({ configured: false, scopes: [], servers: [] });
  });
});

// ───────────────────────────── the rendered panel ────────────────────────────

type Payload = Record<string, unknown>;

async function mountPanel(payload: Payload | null, opts: { status?: number; reject?: boolean } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('main');
  root.id = 'panel-root';
  document.body.append(root);

  const fetchMock = vi.fn().mockImplementation(async () => {
    if (opts.reject) throw new Error('NetworkError when attempting to fetch resource');
    return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => payload };
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  const mod = await import(/* @vite-ignore */ PANEL_JS);
  const dispose = mod.default.mount(root, { session: { user: 'mdopp' } });
  // The panel fetches on mount; let the microtask chain settle.
  await new Promise(r => setTimeout(r, 0));
  return { root, dispose, fetchMock };
}

const okPayload = (projects: unknown[], sources?: Payload): Payload => ({
  workspace: '/workspace',
  projects,
  sources: sources ?? {
    checkouts: { ok: true, detail: '/workspace' },
    sessions: { ok: true, detail: 'tmux session "claude"' },
    mcp: { ok: true, detail: '/workspace/.claude.json' },
  },
});

describe('claude-dev config UI: the projects panel renders (acceptance 1-3, DOM)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders one row per checkout with its session and MCP state', async () => {
    const { root } = await mountPanel(okPayload([
      {
        name: 'servicebay', path: '/workspace/servicebay', developmentTarget: true,
        session: { running: true },
        mcp: { configured: true, scopes: ['user'], servers: ['atHome-Servicebay'] },
      },
      {
        name: 'servicebay-templates', path: '/workspace/servicebay-templates', developmentTarget: false,
        session: { running: false },
        mcp: { configured: false, scopes: [], servers: [] },
      },
    ]));

    const rows = root.querySelectorAll('.projects-table tbody tr');
    expect(rows.length).toBe(2);

    const sb = root.querySelector('tr[data-project="servicebay"]')!;
    expect(sb.textContent).toContain('/workspace/servicebay');
    expect(sb.querySelector('[data-session]')!.getAttribute('data-session')).toBe('running');
    expect(sb.querySelector('[data-session]')!.textContent).toContain('Running');
    expect(sb.querySelector('[data-mcp]')!.getAttribute('data-mcp')).toBe('configured');
    expect(sb.querySelector('[data-mcp]')!.textContent).toContain('atHome-Servicebay');

    const tmpl = root.querySelector('tr[data-project="servicebay-templates"]')!;
    expect(tmpl.querySelector('[data-session]')!.getAttribute('data-session')).toBe('stopped');
    expect(tmpl.querySelector('[data-session]')!.textContent).toContain('Not running');
    // A non-development checkout is never auto-started — say so, so "not
    // running" doesn't read as a fault.
    expect(tmpl.querySelector('[data-session]')!.textContent).toContain('no CLAUDE.md');
    expect(tmpl.querySelector('[data-mcp]')!.getAttribute('data-mcp')).toBe('none');

    // No error and no empty state on the happy path.
    expect(root.querySelector('.projects-error')).toBeNull();
    expect(root.querySelector('.projects-empty')).toBeNull();
  });

  it('an EMPTY workspace renders an explicit empty state, not a blank table', async () => {
    const { root } = await mountPanel(okPayload([]));
    const empty = root.querySelector('.projects-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('No checkouts yet');
    expect(empty!.textContent).toContain('/workspace');
    // The distinguishing assertions: no table AND no error. An empty table
    // would be the silent-nothing this panel exists to end.
    expect(root.querySelector('.projects-table')).toBeNull();
    expect(root.querySelector('.projects-error')).toBeNull();
  });

  it('a FAILED read renders an error, never the empty state', async () => {
    const { root } = await mountPanel({ error: 'could not list the checkouts in /workspace: EACCES' }, { status: 500 });
    const error = root.querySelector('.projects-error');
    expect(error).not.toBeNull();
    expect(error!.getAttribute('role')).toBe('alert');
    expect(error!.textContent).toContain('EACCES');
    // The two "nothings" must not collapse into each other.
    expect(root.querySelector('.projects-empty')).toBeNull();
    expect(root.querySelector('.projects-table')).toBeNull();
  });

  it('a network failure renders an error too, not an empty workspace', async () => {
    const { root } = await mountPanel(null, { reject: true });
    expect(root.querySelector('.projects-error')).not.toBeNull();
    expect(root.querySelector('.projects-error')!.textContent).toContain('NetworkError');
    expect(root.querySelector('.projects-empty')).toBeNull();
  });

  it('a malformed response is an error, not a silently empty list', async () => {
    const { root } = await mountPanel({ workspace: '/workspace' });
    expect(root.querySelector('.projects-error')).not.toBeNull();
    expect(root.querySelector('.projects-empty')).toBeNull();
  });

  it('a partially failed read still lists the checkouts, marks that column Unknown, and says why', async () => {
    const { root } = await mountPanel(okPayload(
      [{
        name: 'servicebay', path: '/workspace/servicebay', developmentTarget: true,
        session: null,
        mcp: { configured: true, scopes: ['user'], servers: ['atHome-Servicebay'] },
      }],
      {
        checkouts: { ok: true },
        sessions: { ok: false, error: 'spawnSync tmux ENOENT' },
        mcp: { ok: true },
      },
    ));

    const warning = root.querySelector('.projects-source-warning');
    expect(warning).not.toBeNull();
    expect(warning!.getAttribute('data-source')).toBe('sessions');
    expect(warning!.textContent).toContain('ENOENT');
    expect(warning!.textContent).toContain('Unknown');

    const cell = root.querySelector('tr[data-project="servicebay"] [data-session]')!;
    expect(cell.getAttribute('data-session')).toBe('unknown');
    expect(cell.textContent).toContain('Unknown');
    // The readable column is untouched.
    expect(root.querySelector('[data-mcp]')!.getAttribute('data-mcp')).toBe('configured');
  });

  it('refreshes on demand and stops touching the DOM once unmounted', async () => {
    const { root, dispose, fetchMock } = await mountPanel(okPayload([]));
    (root.querySelector('.projects-refresh') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.anything());

    dispose();
    (root.querySelector('.projects-refresh') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    // A late response after the panel was swapped out must not repaint it.
    expect(root.querySelector('.projects-loading')).not.toBeNull();
  });
});

describe('claude-dev config UI: the panel is wired into the shell (acceptance 3)', () => {
  it('is registered in the panel manifest', async () => {
    const manifest = await import(/* @vite-ignore */ MANIFEST_JS);
    expect(manifest.PANELS.map((p: { id: string }) => p.id)).toContain('projects');
    const projects = manifest.PANELS.find((p: { id: string }) => p.id === 'projects')!;
    expect(projects.title).toBe('Projects');
    expect(typeof projects.mount).toBe('function');
  });

  it('the shell builds the nav from it and mounts it with no extra step', async () => {
    const html = fs.readFileSync(path.join(CONFIG_UI_DIR, 'public', 'index.html'), 'utf-8');
    document.documentElement.innerHTML = html.slice(html.indexOf('<head>'));

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url === '/api/session'
        ? { user: 'mdopp', name: 'Michael', groups: ['admins'], servicebay: { configured: true } }
        : okPayload([{
          name: 'servicebay', path: '/workspace/servicebay', developmentTarget: true,
          session: { running: true },
          mcp: { configured: true, scopes: ['user'], servers: ['atHome-Servicebay'] },
        }])),
    })));

    vi.resetModules();
    await import(/* @vite-ignore */ SHELL_JS);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(document.getElementById('shell-nav')!.textContent).toContain('Projects');
    // The shell's "nothing here yet" placeholder is gone now that a panel exists.
    expect(document.getElementById('shell-nav')!.textContent).not.toContain('No sections yet');
    const panelRoot = document.getElementById('panel-root')!;
    expect(panelRoot.querySelector('.panel-projects')).not.toBeNull();
    expect(panelRoot.querySelector('tr[data-project="servicebay"]')).not.toBeNull();

    vi.unstubAllGlobals();
  });
});
