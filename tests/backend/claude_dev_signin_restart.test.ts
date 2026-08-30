/**
 * claude-dev config UI — SIGN-IN REPAIR + SESSION RESTART (#2682, epic #2674).
 *
 * Acceptance on the issue:
 *   1. the sign-in button reaches the EXISTING whitelisted repair deep-link, so
 *      a lapsed Claude sign-in can be fixed without SSH;
 *   2. restart restarts EXACTLY the targeted project's session; the others are
 *      unaffected.
 *
 * Criterion 2 is unprovable with one session — a restart that takes out every
 * window on the box passes a single-session test cleanly. So every restart test
 * below runs against FOUR sessions, and each window carries a process id: the
 * target's id must CHANGE (it really was restarted, not left alone) while every
 * sibling's id must be BYTE-IDENTICAL afterwards (they were not touched, not
 * merely re-listed under the same name).
 *
 * The tmux fake models the one behaviour that makes this dangerous for real:
 * tmux resolves a window name by exact match FIRST and then by PREFIX. On the
 * box right now `claude:solaris` resolves to `solarisbay`. An unanchored kill
 * would therefore destroy a different project's session and report success, so
 * there is a test that fails if the `=` anchor is ever dropped.
 *
 * And the failure mode this unit is most likely to produce: a restart that
 * reports success while the session is not back. `start-claude` exits 0 in
 * cases where no window survives (its `--continue` fallback can die
 * milliseconds later), so its exit code proves nothing — tmux is re-asked, and
 * the tests below drive the three ways that answer can go wrong (no window, an
 * unreadable tmux, a kill that failed) and require a loud non-2xx for each.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_UI_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui');
const SERVER_MJS = path.join(CONFIG_UI_DIR, 'server.mjs');
const PANEL_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'projects.js');
const TEMPLATE_YML = path.join(REPO_ROOT, 'templates', 'claude-dev', 'template.yml');

const ADMIN: Record<string, string> = { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' };

type Res = { status: number; body: string };

function request(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.setEncoding('utf-8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const failure = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });

/**
 * A workspace that mirrors the real box: four development checkouts, one of
 * them (`solaris`) a strict PREFIX of another (`solarisbay`) — which is the
 * shape that makes an unanchored tmux target destroy the wrong session.
 */
const CHECKOUTS = ['servicebay', 'solaris', 'solarisbay', 'usage-metrics'];

async function setup(opts: { appUrl?: string | null } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dev-restart-'));
  for (const name of CHECKOUTS) {
    fs.mkdirSync(path.join(workspace, name, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, name, 'CLAUDE.md'), '# notes\n');
  }

  let nextPid = 1000;
  const state = {
    /** name → the pid of the process in that tmux window. Identity, not a flag. */
    windows: new Map<string, number>(CHECKOUTS.map(n => [n, nextPid++])),
    calls: [] as Array<{ file: string; args: string[] }>,
    tmuxReadFails: null as Error | null,
    killFails: '' as string,
    /** start-claude exits 0 but produces no window — the silent-success shape. */
    startIsANoOp: false,
    startFails: '' as string,
  };

  const runTmux = (args: string[]) => {
    state.calls.push({ file: 'tmux', args });
    if (args[0] === 'list-windows') {
      if (state.tmuxReadFails) throw state.tmuxReadFails;
      return [...state.windows.keys()].join('\n') + '\n';
    }
    if (args[0] === 'kill-window') {
      if (state.killFails) throw failure(state.killFails);
      const target = String(args[2]).split(':')[1] ?? '';
      // Real tmux resolution: `=name` is exact; a bare name falls back to a
      // PREFIX match, which is precisely the sibling-killing hazard.
      const names = [...state.windows.keys()];
      const resolved = target.startsWith('=')
        ? names.find(w => w === target.slice(1))
        : (names.find(w => w === target) ?? names.find(w => w.startsWith(target)));
      if (!resolved) throw failure(`can't find window: ${target.replace(/^=/, '')}`);
      state.windows.delete(resolved);
      return '';
    }
    throw new Error(`unexpected tmux ${args.join(' ')}`);
  };

  const runCommand = (file: string, args: string[]) => {
    state.calls.push({ file, args });
    if (file !== 'start-claude') throw new Error(`unexpected command: ${file}`);
    if (state.startFails) throw failure(state.startFails);
    if (state.startIsANoOp) return '';
    const name = args[args.length - 1];
    // start-claude skips a checkout that already has a live window, so an
    // existing window keeps its process — it does NOT get a new pid.
    if (!state.windows.has(name)) state.windows.set(name, nextPid++);
    return '';
  };

  const mod = await import(/* @vite-ignore */ SERVER_MJS);
  const server = mod.createConfigUiServer({
    requiredGroup: 'admins',
    servicebay: {
      url: 'http://host.containers.internal:5888',
      token: 'sb_deadbeef_never_leaves_the_server',
      appUrl: opts.appUrl === undefined ? 'https://admin.example.com' : opts.appUrl,
    },
    projects: { devHome: workspace, homeDir: workspace, tmuxSession: 'claude', runTmux, runCommand },
    log: () => {},
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    mod,
    workspace,
    state,
    port,
    /** A snapshot of every window's process identity, for before/after diffing. */
    pids: () => Object.fromEntries(state.windows),
    restart: (name: unknown, headers = ADMIN) =>
      request(port, 'POST', '/api/projects/restart', headers, { name }),
    session: () => request(port, 'GET', '/api/session', ADMIN),
    close: async () => {
      await new Promise<void>(r => server.close(() => r()));
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const ok = (res: Res) => JSON.parse(res.body);

// ───────────── acceptance 2: restart exactly ONE session ─────────────

describe('restarting a session touches exactly that project (acceptance 2)', () => {
  let h: Harness;
  beforeEach(async () => { vi.resetModules(); h = await setup(); });
  afterEach(async () => { await h.close(); });

  it('restarts the target and leaves every sibling process byte-identical', async () => {
    const before = h.pids();
    expect(Object.keys(before)).toHaveLength(4);

    const res = await h.restart('servicebay');
    expect(res.status).toBe(200);
    const body = ok(res);
    expect(body.restarted.name).toBe('servicebay');
    expect(body.restarted.wasRunning).toBe(true);
    expect(body.restarted.session).toEqual({ running: true });
    expect(body.warnings).toEqual([]);

    const after = h.pids();
    // The target really was restarted: a NEW process, not the old one left be.
    expect(after.servicebay).toBeDefined();
    expect(after.servicebay).not.toBe(before.servicebay);
    // …and the other three are the SAME processes, not merely same-named ones.
    for (const other of ['solaris', 'solarisbay', 'usage-metrics']) {
      expect(after[other]).toBe(before[other]);
    }
    // The server says so out loud too, so the operator can read it off screen.
    expect(body.restarted.others.sort()).toEqual(['solaris', 'solarisbay', 'usage-metrics']);
  });

  it('anchors the tmux target with "=" so a name that PREFIXES another cannot kill it', async () => {
    // `solaris` is a strict prefix of `solarisbay`. Take its window away, so an
    // unanchored `-t claude:solaris` would fall through to `solarisbay`.
    h.state.windows.delete('solaris');
    const before = h.pids();

    const res = await h.restart('solaris');
    expect(res.status).toBe(200);

    const after = h.pids();
    // solarisbay is untouched — the whole point.
    expect(after.solarisbay).toBe(before.solarisbay);
    expect(after.servicebay).toBe(before.servicebay);
    expect(after['usage-metrics']).toBe(before['usage-metrics']);
    expect(after.solaris).toBeDefined();

    // The anchor is asserted directly, not only through its effect: a future
    // refactor that drops it must fail here rather than in a subtle way.
    const kills = h.state.calls.filter(c => c.file === 'tmux' && c.args[0] === 'kill-window');
    expect(kills).toHaveLength(1);
    expect(kills[0].args[2]).toBe('claude:=solaris');
  });

  it('says a stopped session was STARTED, rather than reporting a restart that never was', async () => {
    h.state.windows.delete('usage-metrics');
    const body = ok(await h.restart('usage-metrics'));
    expect(body.restarted.wasRunning).toBe(false);
    expect(body.warnings.join(' ')).toContain('STARTED rather than restarted');
    expect(body.restarted.session).toEqual({ running: true });
  });

  it('stops before it starts, because start-claude skips a checkout that still has a window', async () => {
    await h.restart('servicebay');
    const order = h.state.calls
      .filter(c => (c.file === 'tmux' && c.args[0] === 'kill-window') || c.file === 'start-claude')
      .map(c => (c.file === 'start-claude' ? 'start' : 'stop'));
    expect(order).toEqual(['stop', 'start']);
  });
});

// ───────── the failure mode: success reported while nothing is back ─────────

describe('a restart that did not work FAILS LOUDLY', () => {
  let h: Harness;
  beforeEach(async () => { vi.resetModules(); h = await setup(); });
  afterEach(async () => { await h.close(); });

  it('re-asks tmux: start-claude exiting 0 with no window left is a 500, not an ok', async () => {
    h.state.startIsANoOp = true;
    const res = await h.restart('servicebay');
    expect(res.status).toBe(500);
    const body = ok(res);
    expect(body.error).toContain('did NOT come back');
    expect(body.ok).toBeUndefined();
    // The siblings are still untouched even on the failing path.
    expect([...h.state.windows.keys()].sort()).toEqual(['solaris', 'solarisbay', 'usage-metrics']);
  });

  it('an unreadable tmux is 502 UNKNOWN — nothing is killed and nothing is claimed', async () => {
    h.state.tmuxReadFails = new Error('tmux: command not found');
    const before = h.pids();
    const res = await h.restart('servicebay');
    expect(res.status).toBe(502);
    expect(ok(res).error).toContain('nothing was restarted');
    // A read we could not do must not become a destructive act.
    expect(h.pids()).toEqual(before);
    expect(h.state.calls.some(c => c.args[0] === 'kill-window')).toBe(false);
    expect(h.state.calls.some(c => c.file === 'start-claude')).toBe(false);
  });

  it('a kill that really failed is a 500 and start-claude is never reached', async () => {
    h.state.killFails = 'server exited unexpectedly';
    const res = await h.restart('servicebay');
    expect(res.status).toBe(500);
    expect(ok(res).error).toContain('could not be stopped');
    expect(ok(res).detail).toContain('server exited unexpectedly');
    expect(h.state.calls.some(c => c.file === 'start-claude')).toBe(false);
  });

  it('a restart of something that is not there is a 404, never a quiet success', async () => {
    const before = h.pids();
    const res = await h.restart('not-a-checkout');
    expect(res.status).toBe(404);
    expect(ok(res).error).toContain('no checkout named "not-a-checkout"');
    expect(h.pids()).toEqual(before);
    expect(h.state.calls).toEqual([]);
  });

  it('a project that was REMOVED is a 409, not a resurrected session', async () => {
    // The no-autostart marker Remove drops (#2680) — the operator took this
    // session down on purpose and the entrypoint honours that.
    fs.mkdirSync(path.join(h.workspace, '.claude-dev', 'no-autostart'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'usage-metrics'), 'removed\n');

    const res = await h.restart('usage-metrics');
    expect(res.status).toBe(409);
    expect(ok(res).error).toContain('do-not-auto-start');
    expect(h.state.calls.some(c => c.file === 'start-claude')).toBe(false);
  });

  it('refuses a name that is not one path segment, before anything runs', async () => {
    for (const bad of ['../etc', 'a/b', '', 'has space']) {
      const res = await h.restart(bad);
      expect(res.status).toBe(400);
    }
    expect(h.state.calls).toEqual([]);
  });

  it('rides the one auth gate: an unauthenticated restart never reaches tmux', async () => {
    const res = await request(h.port, 'POST', '/api/projects/restart', {}, { name: 'servicebay' });
    expect(res.status).toBe(401);
    expect(h.state.calls).toEqual([]);
  });
});

// ─────────── acceptance 1: the sign-in repair deep-link ───────────

describe('the Claude sign-in repair link (acceptance 1)', () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it('is the EXISTING whitelisted deep-link on the app origin, carrying a preset key not a command', async () => {
    vi.resetModules();
    h = await setup();
    const body = ok(await h.session());

    expect(body.claudeSignInUrl).toBe(
      'https://admin.example.com/terminal?container=claude-dev-claude-dev&run=claude-login');
    const url = new URL(body.claudeSignInUrl);
    // `run` names a preset KEY that ServiceBay looks up in its own whitelist —
    // a command in the URL would be remote code execution by link.
    expect(url.searchParams.get('run')).toBe('claude-login');
    expect(url.searchParams.get('container')).toBe('claude-dev-claude-dev');
    expect([...url.searchParams.keys()].sort()).toEqual(['container', 'run']);
    expect(body.servicebay.appUrl).toBe('https://admin.example.com');
  });

  it('is null — not a broken link — when the box has no usable public domain', async () => {
    vi.resetModules();
    h = await setup({ appUrl: null });
    const body = ok(await h.session());
    expect(body.claudeSignInUrl).toBeNull();
    expect(body.servicebay.appUrl).toBeNull();
  });

  it('adds NO server route of its own for the sign-in, and does not widen the whitelist', async () => {
    vi.resetModules();
    h = await setup();
    // Every route this server publishes, listed: none of them is a sign-in.
    const routes = Object.keys(h.mod.API_ROUTES);
    expect(routes.filter(r => /login|signin|sign-in|terminal|auth/i.test(r) && !r.includes('github')))
      .toEqual([]);
    for (const guess of ['/api/claude/login', '/api/signin', '/api/terminal']) {
      expect((await request(h.port, 'POST', guess, ADMIN, {})).status).toBe(404);
    }
    // The deep-link constant is a literal preset key; nothing is interpolated.
    expect(h.mod.CLAUDE_LOGIN_DEEP_LINK).toBe('/terminal?container=claude-dev-claude-dev&run=claude-login');
  });
});

describe('the browser-facing ServiceBay origin', () => {
  it('rejects what an unset PUBLIC_DOMAIN renders to, rather than linking at it', async () => {
    vi.resetModules();
    const mod = await import(/* @vite-ignore */ SERVER_MJS);
    // `https://admin.{{PUBLIC_DOMAIN}}` with no domain configured — the case
    // that actually happens on a LAN-only box.
    expect(mod.normalizeAppUrl('https://admin.')).toBeNull();
    expect(mod.normalizeAppUrl('')).toBeNull();
    expect(mod.normalizeAppUrl(undefined)).toBeNull();
    expect(mod.normalizeAppUrl('admin.example.com')).toBeNull();
    expect(mod.normalizeAppUrl('javascript:alert(1)')).toBeNull();
    expect(mod.normalizeAppUrl('https://admin.example.com/')).toBe('https://admin.example.com');
    expect(mod.normalizeAppUrl(' http://admin.box.lan ')).toBe('http://admin.box.lan');
  });

  it('is NOT the container-side API address, which no browser can reach', async () => {
    vi.resetModules();
    const mod = await import(/* @vite-ignore */ SERVER_MJS);
    const cfg = mod.configFromEnv({
      SERVICEBAY_API_URL: 'http://host.containers.internal:5888',
      SERVICEBAY_APP_URL: 'https://admin.example.com',
    });
    expect(cfg.servicebay.url).toBe('http://host.containers.internal:5888');
    expect(cfg.servicebay.appUrl).toBe('https://admin.example.com');
  });

  it('is wired by the pod manifest from the box\'s own public domain', () => {
    const yml = fs.readFileSync(TEMPLATE_YML, 'utf-8');
    expect(yml).toContain('name: SERVICEBAY_APP_URL');
    expect(yml).toContain('value: "https://admin.{{PUBLIC_DOMAIN}}"');
  });
});

// ─────────────────────────── the rendered panel ───────────────────────────

type Payload = Record<string, unknown>;

const okPayload = (projects: unknown[]): Payload => ({
  workspace: '/workspace',
  projects,
  sources: {
    checkouts: { ok: true, detail: '/workspace' },
    sessions: { ok: true, detail: 'tmux session "claude"' },
    mcp: { ok: true, detail: '/workspace/.claude.json' },
  },
});

const row = (name: string, over: Payload = {}): Payload => ({
  name,
  path: `/workspace/${name}`,
  developmentTarget: true,
  session: { running: true },
  mcp: { configured: true, scopes: ['user'], servers: ['servicebay'] },
  managed: false,
  ...over,
});

/** Mount the panel with a scripted `fetch`: the list first, then the actions. */
async function mountPanel(session: Payload | null, list: Payload, action?: {
  status: number;
  body: Payload;
}) {
  document.body.replaceChildren();
  const root = document.createElement('main');
  root.id = 'panel-root';
  document.body.append(root);

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/projects/restart')) {
      const status = action?.status ?? 200;
      return { ok: status < 400, status, json: async () => action?.body ?? {} };
    }
    return { ok: true, status: 200, json: async () => list };
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  const mod = await import(/* @vite-ignore */ PANEL_JS);
  const dispose = mod.default.mount(root, { session });
  await new Promise(r => setTimeout(r, 0));
  return { root, dispose, calls };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('the panel renders the sign-in repair and the restart button (DOM)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the repair as a real link at the deep-link the session supplied', async () => {
    const { root } = await mountPanel(
      { user: 'mdopp', claudeSignInUrl: 'https://admin.example.com/terminal?container=claude-dev-claude-dev&run=claude-login' },
      okPayload([row('servicebay')]),
    );
    const box = root.querySelector('.projects-signin')!;
    expect(box.getAttribute('data-signin')).toBe('available');
    const link = box.querySelector('a.projects-signin-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href'))
      .toBe('https://admin.example.com/terminal?container=claude-dev-claude-dev&run=claude-login');
    expect(link.getAttribute('rel')).toContain('noopener');
    // It is a LINK, not a call: the panel must not post anywhere to sign in.
    expect(link.tagName).toBe('A');
  });

  it('says WHY there is no link instead of rendering a dead one', async () => {
    const { root } = await mountPanel({ user: 'mdopp', claudeSignInUrl: null }, okPayload([row('servicebay')]));
    const box = root.querySelector('.projects-signin')!;
    expect(box.getAttribute('data-signin')).toBe('unavailable');
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toContain('claude auth login');
  });

  it('a session payload that never loaded is unavailable, not a link to "null"', async () => {
    const { root } = await mountPanel(null, okPayload([row('servicebay')]));
    expect(root.querySelector('.projects-signin')!.getAttribute('data-signin')).toBe('unavailable');
    expect(root.querySelector('.projects-signin a')).toBeNull();
  });

  it('offers Restart on every row and posts only that row\'s name', async () => {
    const { root, calls } = await mountPanel(
      { user: 'mdopp', claudeSignInUrl: null },
      okPayload([row('servicebay'), row('solarisbay', { session: { running: false } })]),
      {
        status: 200,
        body: {
          ok: true,
          restarted: { name: 'solarisbay', path: '/workspace/solarisbay', wasRunning: false, session: { running: true }, others: ['servicebay'] },
          warnings: [],
        },
      },
    );

    // Present on the stopped row too — that is the one you want to restart.
    expect(root.querySelectorAll('button.projects-restart')).toHaveLength(2);
    const button = root.querySelector('button[data-project-restart="solarisbay"]') as HTMLButtonElement;
    button.click();
    await settle();

    const restartCall = calls.find(c => c.url === '/api/projects/restart')!;
    expect(restartCall).toBeDefined();
    expect(restartCall.init!.method).toBe('POST');
    expect(JSON.parse(String(restartCall.init!.body))).toEqual({ name: 'solarisbay' });

    // The report names the sessions that were LEFT ALONE, so "only mine" is
    // something the operator reads rather than something the page asserts.
    const result = root.querySelector('.projects-result')!;
    expect(result.textContent).toContain('Started the Claude session for solarisbay');
    expect(result.textContent).toContain('servicebay');
  });

  it('renders the server\'s warnings as prominently as the headline', async () => {
    const { root } = await mountPanel(
      { user: 'mdopp', claudeSignInUrl: null },
      okPayload([row('servicebay')]),
      {
        status: 200,
        body: {
          ok: true,
          restarted: { name: 'servicebay', path: '/workspace/servicebay', wasRunning: true, session: { running: true }, others: [] },
          warnings: ['other sessions disappeared during this restart, which should not happen: solarisbay'],
        },
      },
    );
    (root.querySelector('button[data-project-restart="servicebay"]') as HTMLButtonElement).click();
    await settle();

    expect(root.querySelector('.projects-result-partial')).not.toBeNull();
    expect(root.querySelector('.projects-warning')!.textContent).toContain('solarisbay');
  });

  it('a failed restart renders an error, never a success line', async () => {
    const { root } = await mountPanel(
      { user: 'mdopp', claudeSignInUrl: null },
      okPayload([row('servicebay')]),
      { status: 500, body: { error: '"servicebay" has no tmux window after the restart — the session did NOT come back' } },
    );
    (root.querySelector('button[data-project-restart="servicebay"]') as HTMLButtonElement).click();
    await settle();

    const error = root.querySelector('.projects-action-error')!;
    expect(error).not.toBeNull();
    expect(error.textContent).toContain('did NOT come back');
    expect(root.querySelector('.projects-result')).toBeNull();
  });
});
