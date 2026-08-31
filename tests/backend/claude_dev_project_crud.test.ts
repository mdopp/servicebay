/**
 * claude-dev config UI — ADD / REMOVE a project (#2680, epic #2674).
 *
 * Acceptance on the issue, and why each one needs a *count* or a *negative*
 * rather than a happy path:
 *
 *   1. Adding a project yields a working session with its OWN delegated,
 *      read-only token. Asserted against the row that was actually WRITTEN to
 *      the token store — not against the arguments the UI passed — and against
 *      the token id recorded in the MCP entry, which is what the container
 *      will really authenticate with.
 *
 *   2. Removing revokes EXACTLY its child token, siblings unaffected. A
 *      one-project test cannot fail here: a revoke that takes out every child
 *      of the parent passes it. So there are always two projects, and the
 *      other one's token has to still VERIFY afterwards.
 *
 *   3. Re-adding after removal orphans neither a token nor an MCP entry.
 *      Counted before and after the whole cycle (0 → 1 → 0 → 1), the way
 *      #2673's mint counting was proven — "does not orphan" is a design
 *      property, not something you get for free.
 *
 * Plus the bound on the destructive path, which is the part that would hurt if
 * it were wrong: Remove must not touch a checkout it does not own (the shared
 * workspace holds live hand-cloned repos other people are working in), and a
 * remove of something that is not there must FAIL rather than quietly succeed.
 *
 * The token store is the real one on a temp DATA_DIR — `GET /api/system/
 * api-tokens` carries no `tokenScope` and takes only a session cookie, so a
 * read-scoped `sb_` token cannot count tokens over the box API. Counting has
 * to happen in-process (same reason as
 * `packages/backend/src/lib/install/manifestAssembler.mintApiToken.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_UI_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui');
const SERVER_MJS = path.join(CONFIG_UI_DIR, 'server.mjs');
const PANEL_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'projects.js');

const ADMIN: Record<string, string> = { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' };

// Real token store, real delegation, real revoke — on a throwaway DATA_DIR.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});
const loadTokens = () => import('@/lib/auth/apiTokens');

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
 * A whole claude-dev container in miniature: a workspace holding ONE
 * hand-cloned checkout (nobody's to remove), a tmux window list, a
 * `~/.claude.json`, the container CLIs as fakes that really mutate that state,
 * and a ServiceBay standing on the REAL token store.
 */
async function setup() {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-claude-dev-crud-'));
  const tokens = await loadTokens();

  // The container's own read-only, non-expiring token (#2673) — the parent of
  // every project token minted below.
  const parent = await tokens.createToken({
    name: 'claude-dev', scopes: ['read'], neverExpires: true, createdBy: 'install',
  });

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-claude-dev-ws-'));
  // Hand-cloned by a human, wired only by the container-wide user-scope entry.
  fs.mkdirSync(path.join(workspace, 'handmade', '.git'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'handmade', 'CLAUDE.md'), '# notes\n');
  const claudeJson = path.join(workspace, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    mcpServers: { servicebay: { type: 'http', url: 'http://host.containers.internal:5888/mcp' } },
    projects: {},
  }));

  const readJson = () => JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
  const writeJson = (v: unknown) => fs.writeFileSync(claudeJson, JSON.stringify(v));

  const state = {
    windows: ['handmade'] as string[],
    calls: [] as Array<{ file: string; args: string[]; cwd?: string }>,
    cloneFails: '' as string,
    mcpAddFails: '' as string,
    startFails: '' as string,
    tmuxReadFails: null as Error | null,
    servicebayRevokeStatus: 0,
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
      if (state.servicebayRevokeStatus && req.method === 'DELETE') {
        return send(state.servicebayRevokeStatus, { error: 'ServiceBay is having a bad day' });
      }
      const text = await readRequestBody(req);
      const headers = { authorization: String(req.headers.authorization ?? '') };
      const asRequest = new Request(`http://servicebay.invalid${req.url}`, {
        method: req.method,
        headers: { ...headers, 'content-type': 'application/json' },
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
    state.calls.push({ file, args, cwd: opts.cwd });
    if (file === 'git' && args[0] === 'clone') {
      if (state.cloneFails) throw failure(state.cloneFails);
      const target = args[3];
      fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# notes\n');
      return '';
    }
    if (file === 'git' && args[0] === 'config') return '';
    if (file === 'claude' && args[1] === 'add') {
      if (state.mcpAddFails) throw failure(state.mcpAddFails);
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
      if (state.startFails) throw failure(state.startFails);
      const name = args[args.length - 1];
      if (!state.windows.includes(name)) state.windows.push(name);
      return '';
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const runTmux = (args: string[]) => {
    state.calls.push({ file: 'tmux', args });
    if (args[0] === 'list-windows') {
      if (state.tmuxReadFails) throw state.tmuxReadFails;
      return state.windows.join('\n') + '\n';
    }
    if (args[0] === 'kill-window') {
      // Real tmux: a `=`-anchored window name matches EXACTLY, an unanchored
      // one also matches by prefix. Modelled, so a stop that dropped the anchor
      // would show up here as the sibling it took out (see
      // claude_dev_signin_restart.test.ts, which asserts the anchor directly).
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
  const port = (ui.address() as AddressInfo).port;

  return {
    tokens, parent, workspace, claudeJson, readJson, state, port, servicebayUrl,
    /** Every token row currently on disk — the denominator for every claim. */
    stored: () => tokens.listTokens(),
    children: async () => (await tokens.listTokens()).filter(t => t.parentId === parent.token.id),
    /** The LOCAL-scope entries, i.e. the projects this UI claims to own. */
    localEntries: () => Object.entries(readJson().projects ?? {})
      .filter(([, e]) => Boolean((e as { mcpServers?: Record<string, unknown> })?.mcpServers?.servicebay)),
    /** The `sb_…` secret the container would actually authenticate with. */
    recordedSecret: (name: string) => {
      const entry = readJson().projects?.[path.join(workspace, name)]?.mcpServers?.servicebay;
      return String(entry?.headers?.Authorization ?? '').replace(/^Bearer\s+/, '');
    },
    add: (body: unknown, headers = ADMIN) => request(port, 'POST', '/api/projects', headers, body),
    remove: (name: string, headers = ADMIN) =>
      request(port, 'DELETE', `/api/projects?name=${encodeURIComponent(name)}`, headers),
    /** Remove with the explicit "I know this page did not add it" acknowledgement (#2713). */
    removeAnyway: (name: string, headers = ADMIN) =>
      request(port, 'DELETE',
        `/api/projects?name=${encodeURIComponent(name)}&acknowledgeUnmanaged=1`, headers),
    list: () => request(port, 'GET', '/api/projects', ADMIN),
    close: async () => {
      await new Promise<void>(r => ui.close(() => r()));
      await new Promise<void>(r => servicebay.close(() => r()));
    },
  };
}

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await setup();
});

afterEach(async () => {
  await h.close();
  await (await loadTokens()).flushPendingStamps();
  await fsp.rm(h.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const ok = (res: Res) => JSON.parse(res.body);

// ─────────────────── acceptance 1: add yields a real session ────────────────

describe('adding a project (acceptance 1)', () => {
  it('clones, delegates its OWN read-only token, wires MCP and starts the session', async () => {
    expect(await h.children()).toHaveLength(0);

    const res = await h.add({ url: 'https://github.com/mdopp/solarisbay.git' });
    expect(res.status).toBe(201);
    const body = ok(res);
    expect(body.project.name).toBe('solarisbay');
    expect(body.project.cloned).toBe(true);
    expect(body.warnings).toEqual([]);

    // The checkout is really there.
    expect(fs.existsSync(path.join(h.workspace, 'solarisbay', '.git'))).toBe(true);

    // Its OWN token: one new row, delegated from this container's token, read
    // scope only — read off the row that was WRITTEN, not the request.
    const children = await h.children();
    expect(children).toHaveLength(1);
    expect(children[0].scopes).toEqual(['read']);
    expect(children[0].parentId).toBe(h.parent.token.id);
    expect(children[0].id).not.toBe(h.parent.token.id);

    // …and the credential the container will actually present is that child.
    const recorded = h.recordedSecret('solarisbay');
    expect(recorded).toMatch(/^sb_[0-9a-f]{8}_/);
    const verified = await h.tokens.verifyToken(recorded);
    expect(verified?.id).toBe(children[0].id);
    expect(verified?.scopes).toEqual(['read']);
    expect(recorded).not.toBe(h.parent.secret);

    // A session, confirmed by asking tmux — not by trusting start-claude.
    expect(body.project.session).toEqual({ running: true });
    expect(h.state.windows).toContain('solarisbay');

    // safe.directory was registered the same idempotent way the entrypoint does.
    expect(h.state.calls).toContainEqual({
      file: 'git',
      args: ['config', '--global', '--replace-all', '--fixed-value',
        'safe.directory', path.join(h.workspace, 'solarisbay'), path.join(h.workspace, 'solarisbay')],
      cwd: h.workspace,
    });
  });

  it('says so out loud when the session did NOT come up, instead of reporting a clean add', async () => {
    h.state.startFails = 'start-claude: nothing started.';
    const body = ok(await h.add({ url: 'https://github.com/mdopp/solarisbay.git' }));
    expect(body.project.session).toEqual({ running: false });
    expect(body.warnings.join(' ')).toContain('no tmux window named "solarisbay" is running');
    // The token and the entry are still real — the report is partial, not fake.
    expect(await h.children()).toHaveLength(1);
  });

  it('adopts an existing checkout rather than refusing it, and never re-clones over it', async () => {
    const body = ok(await h.add({ name: 'handmade' }));
    expect(body.project.cloned).toBe(false);
    expect(h.state.calls.filter(c => c.file === 'git' && c.args[0] === 'clone')).toHaveLength(0);
    expect(await h.children()).toHaveLength(1);
  });

  it('refuses a hostile name or remote before touching anything', async () => {
    for (const bad of [{ name: '../escape', url: 'https://example.com/x.git' }, { url: 'ext::sh -c whoami' }]) {
      const res = await h.add(bad);
      expect(res.status).toBe(400);
    }
    expect(await h.children()).toHaveLength(0);
    expect(h.state.calls.filter(c => c.args?.[0] === 'clone')).toHaveLength(0);
  });

  it('refuses a target that exists but is not a checkout (409), leaving it alone', async () => {
    fs.mkdirSync(path.join(h.workspace, 'notarepo'));
    fs.writeFileSync(path.join(h.workspace, 'notarepo', 'keep.txt'), 'mine');
    const res = await h.add({ name: 'notarepo', url: 'https://example.com/x.git' });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(h.workspace, 'notarepo', 'keep.txt'), 'utf-8')).toBe('mine');
    expect(await h.children()).toHaveLength(0);
  });

  it('revokes the token again when the MCP entry cannot be written — no orphan', async () => {
    h.state.mcpAddFails = 'claude: could not write ~/.claude.json';
    const res = await h.add({ url: 'https://github.com/mdopp/solarisbay.git' });
    expect(res.status).toBe(500);
    expect(ok(res).error).toContain('its token was revoked again');
    // The count is the proof: a minted-but-unrecorded token would sit here.
    expect(await h.children()).toHaveLength(0);
    expect(h.localEntries()).toHaveLength(0);
  });

  it('is behind the same auth gate as the read, and an anonymous POST changes nothing', async () => {
    const res = await h.add({ url: 'https://github.com/mdopp/solarisbay.git' }, {});
    expect(res.status).toBe(401);
    expect(await h.children()).toHaveLength(0);
    expect(fs.existsSync(path.join(h.workspace, 'solarisbay'))).toBe(false);
  });
});

// ────────────── acceptance 2: remove revokes EXACTLY its own child ───────────

describe('removing a project (acceptance 2)', () => {
  it('revokes only its own child token — the sibling still authenticates', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    await h.add({ url: 'https://github.com/mdopp/beta.git' });
    const alphaSecret = h.recordedSecret('alpha');
    const betaSecret = h.recordedSecret('beta');
    expect(await h.children()).toHaveLength(2);

    const res = await h.remove('alpha');
    expect(res.status).toBe(200);
    const body = ok(res);
    expect(body.removed.name).toBe('alpha');
    expect(body.removed.checkoutDeleted).toBe(false);

    // One row gone, and it is alpha's.
    const left = await h.children();
    expect(left).toHaveLength(1);
    expect(await h.tokens.verifyToken(alphaSecret)).toBeNull();
    // THE claim a single-project test cannot make: beta is untouched.
    const beta = await h.tokens.verifyToken(betaSecret);
    expect(beta?.id).toBe(left[0].id);
    expect(beta?.scopes).toEqual(['read']);

    // Its MCP entry went with it; beta's did not.
    expect(h.localEntries().map(([p]) => path.basename(p))).toEqual(['beta']);
    // Its session stopped; beta's did not.
    expect(h.state.windows).not.toContain('alpha');
    expect(h.state.windows).toContain('beta');
    // And the parent — the container's own credential — is still live.
    expect((await h.tokens.verifyToken(h.parent.secret))?.id).toBe(h.parent.token.id);
  });

  it('leaves the checkout on disk and says so', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    fs.writeFileSync(path.join(h.workspace, 'alpha', 'uncommitted.txt'), 'work in progress');
    const body = ok(await h.remove('alpha'));
    expect(body.removed.checkoutDeleted).toBe(false);
    expect(fs.readFileSync(path.join(h.workspace, 'alpha', 'uncommitted.txt'), 'utf-8')).toBe('work in progress');
  });

  it('drops a marker so the container\'s 300s reconcile does not restart what was just stopped', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    await h.remove('alpha');
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'alpha'))).toBe(true);
    // Adding it back clears the marker again.
    await h.add({ name: 'alpha' });
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'alpha'))).toBe(false);
  });

  it('keeps the MCP entry when ServiceBay refuses the revoke, so the retry still knows the token', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    h.state.servicebayRevokeStatus = 500;
    const res = await h.remove('alpha');
    expect(res.status).toBe(502);
    // Nothing was half-done: the token is still live AND still recorded.
    expect(await h.children()).toHaveLength(1);
    expect(h.localEntries()).toHaveLength(1);

    h.state.servicebayRevokeStatus = 0;
    expect((await h.remove('alpha')).status).toBe(200);
    expect(await h.children()).toHaveLength(0);
  });

  it('an anonymous DELETE revokes nothing', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    const res = await h.remove('alpha', {});
    expect(res.status).toBe(401);
    expect(await h.children()).toHaveLength(1);
  });
});

// ─────────── acceptance 3: re-add orphans neither token nor entry ────────────

describe('re-adding after a removal (acceptance 3)', () => {
  it('counts 0 → 1 → 0 → 1, for both the tokens and the MCP entries', async () => {
    expect(await h.children()).toHaveLength(0);
    expect(h.localEntries()).toHaveLength(0);

    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    expect(await h.children()).toHaveLength(1);
    expect(h.localEntries()).toHaveLength(1);
    const first = h.recordedSecret('alpha');

    await h.remove('alpha');
    expect(await h.children()).toHaveLength(0);
    expect(h.localEntries()).toHaveLength(0);

    await h.add({ name: 'alpha' });
    const children = await h.children();
    expect(children).toHaveLength(1);          // not 2 — nothing orphaned
    expect(h.localEntries()).toHaveLength(1);  // not a second, stale entry
    // …and it is a genuinely NEW credential, not the revoked one resurrected.
    const second = h.recordedSecret('alpha');
    expect(second).not.toBe(first);
    expect(await h.tokens.verifyToken(first)).toBeNull();
    expect((await h.tokens.verifyToken(second))?.id).toBe(children[0].id);
  });

  it('adding the SAME project twice with no removal in between also stays at one token', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    const first = h.recordedSecret('alpha');
    await h.add({ name: 'alpha' });

    expect(await h.children()).toHaveLength(1);
    expect(h.localEntries()).toHaveLength(1);
    // The superseded token was taken back, not left dangling.
    expect(await h.tokens.verifyToken(first)).toBeNull();
  });
});

// ─────────────────── the destructive path is bounded ────────────────────────

describe('remove is bounded and loud', () => {
  it('refuses a checkout this page did not add, and touches nothing about it', async () => {
    const res = await h.remove('handmade');
    expect(res.status).toBe(409);
    expect(ok(res).error).toContain('was not added through this page');

    // Everything about the hand-cloned repo is exactly as it was.
    expect(fs.existsSync(path.join(h.workspace, 'handmade', 'CLAUDE.md'))).toBe(true);
    expect(h.state.windows).toContain('handmade');
    expect(await h.stored()).toHaveLength(1); // only the container's own token
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'handmade'))).toBe(false);
  });

  it('refuses a project that is not there at all (404), rather than succeeding at nothing', async () => {
    const res = await h.remove('never-existed');
    expect(res.status).toBe(404);
    expect(ok(res).error).toContain('there is no checkout named "never-existed"');
  });

  it('a second remove of the same project is a 404-shaped refusal, not a second success', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    expect((await h.remove('alpha')).status).toBe(200);
    const second = await h.remove('alpha');
    // The checkout is still there (remove deletes nothing), so the refusal is
    // the ownership one — either way it must not be a 200.
    expect(second.status).toBe(409);
    expect(await h.children()).toHaveLength(0);
  });

  it('refuses a traversing name without looking outside the workspace', async () => {
    const res = await request(h.port, 'DELETE', '/api/projects?name=..%2F..%2Fetc', ADMIN);
    expect(res.status).toBe(400);
  });

  it('never removes a checkout directory — no project delete path exists at all', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    await h.remove('alpha');
    expect(fs.existsSync(path.join(h.workspace, 'alpha', '.git'))).toBe(true);
    // Structural, not incidental: the only rmSync in the module clears the
    // no-autostart marker, and it is never pointed at a checkout.
    const source = fs.readFileSync(SERVER_MJS, 'utf-8');
    expect(source).not.toMatch(/rmSync\([^)]*checkoutPath/);
    expect(source.match(/rmSync\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/rmSync\(noAutostartMarker\(/);
  });
});

// ──────────────── the list reports ownership honestly ───────────────────────

describe('GET /api/projects reports whether this page owns a checkout', () => {
  it('marks an added project managed and a hand-cloned one not', async () => {
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    const byName = Object.fromEntries(
      ok(await h.list()).projects.map((p: { name: string }) => [p.name, p]),
    );
    expect(byName['alpha'].managed).toBe(true);
    expect(byName['handmade'].managed).toBe(false);
  });

  it('a failed MCP read makes ownership Unknown (null), never false', async () => {
    fs.writeFileSync(h.claudeJson, '{ not json');
    for (const p of ok(await h.list()).projects) {
      expect(p.managed).toBeNull();
      expect(p.mcp).toBeNull();
    }
  });
});

// ─────────────────────────── the rendered panel ─────────────────────────────

const project = (over: Record<string, unknown> = {}) => ({
  name: 'alpha', path: '/workspace/alpha', developmentTarget: true,
  session: { running: true }, mcp: { configured: true, scopes: ['user', 'local'], servers: ['servicebay'] },
  managed: true, ...over,
});

const payload = (projects: unknown[]) => ({
  workspace: '/workspace',
  projects,
  sources: {
    checkouts: { ok: true }, sessions: { ok: true }, mcp: { ok: true },
  },
});

async function mountPanel(list: unknown, action?: { status: number; body: unknown }) {
  document.body.replaceChildren();
  const root = document.createElement('main');
  document.body.append(root);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const mutating = init?.method && init.method !== 'GET';
    const status = mutating ? (action?.status ?? 201) : 200;
    return { ok: status < 400, status, json: async () => (mutating ? action?.body : list) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  const mod = await import(/* @vite-ignore */ PANEL_JS);
  const dispose = mod.default.mount(root, { session: { user: 'mdopp' } });
  await new Promise(r => setTimeout(r, 0));
  return { root, dispose, calls };
}

describe('the panel offers add/remove only where it is honest to (DOM)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows an add form and a Remove button on a managed row', async () => {
    const { root } = await mountPanel(payload([project()]));
    expect(root.querySelector('form.projects-add')).not.toBeNull();
    expect(root.querySelector('.projects-add input[name="url"]')).not.toBeNull();
    const remove = root.querySelector('button[data-project-remove="alpha"]') as HTMLButtonElement;
    expect(remove).not.toBeNull();
    expect(remove.disabled).toBe(false);
  });

  /**
   * #2713 overturns the old rule here. Remove used to render ONLY on a row this
   * page had added, and every checkout on the real box was hand-cloned — so the
   * feature shipped in #2680 was unreachable for the operator who asked for it.
   * The guard's CONCERN survives (see the confirmation block below); its answer
   * no longer is "not at all".
   */
  it('offers an ENABLED Remove on a checkout this page did NOT add (#2713)', async () => {
    const { root } = await mountPanel(payload([project({ name: 'handmade', managed: false })]));
    const remove = root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement;
    expect(remove).not.toBeNull();
    expect(remove.disabled).toBe(false);
    const cell = root.querySelector('tr[data-project="handmade"] .projects-action')!;
    expect(cell.getAttribute('data-managed')).toBe('false');
    // The row still SAYS this page did not add it — the fact is kept, the
    // dead end is not.
    expect(cell.textContent).toContain('Added outside this page');
  });

  it('disables Remove and says Unknown when ownership could not be read', async () => {
    const { root } = await mountPanel(payload([project({ managed: null })]));
    const cell = root.querySelector('tr[data-project="alpha"] .projects-action')!;
    expect(cell.getAttribute('data-managed')).toBe('unknown');
    // The REMOVE button specifically — the cell also carries Restart (#2682),
    // which stays live because restarting is safe regardless of ownership.
    expect((cell.querySelector('.projects-remove') as HTMLButtonElement).disabled).toBe(true);
    expect((cell.querySelector('.projects-restart') as HTMLButtonElement).disabled).toBe(false);
    expect(cell.textContent).toContain('Unknown');
  });

  it('reports an add that produced no session as a warning, not a clean success', async () => {
    const { root } = await mountPanel(payload([]), {
      status: 201,
      body: {
        project: {
          name: 'alpha', path: '/workspace/alpha', cloned: true,
          token: { id: 'abcd1234', scopes: ['read'] }, session: { running: false },
        },
        warnings: ['no tmux window named "alpha" is running, so this project has no Claude session yet'],
      },
    });
    (root.querySelector('.projects-add') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    const result = root.querySelector('.projects-result')!;
    expect(result.className).toContain('projects-result-partial');
    expect(result.textContent).toContain('NO Claude session running');
    expect(root.querySelector('.projects-warning')!.textContent).toContain('no tmux window');
  });

  it('surfaces a refused remove as an alert and does not pretend it worked', async () => {
    const { root } = await mountPanel(payload([project()]), {
      status: 409, body: { error: '"alpha" was not added through this page' },
    });
    (root.querySelector('button[data-project-remove="alpha"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));

    const alert = root.querySelector('.projects-action-error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('not added through this page');
    expect(root.querySelector('.projects-result')).toBeNull();
  });

  it('sends the remove as a DELETE naming the project', async () => {
    const { root, calls } = await mountPanel(payload([project()]), {
      status: 200,
      body: { removed: { name: 'alpha', path: '/workspace/alpha', tokenId: 'abcd1234', session: { running: false }, checkoutDeleted: false }, warnings: [] },
    });
    (root.querySelector('button[data-project-remove="alpha"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    const del = calls.find(c => c.init?.method === 'DELETE')!;
    expect(del.url).toBe('/api/projects?name=alpha');
  });
});

// ───────── #2713: removing a project this page did not add ──────────────────
//
// The operator asked for a delete and never saw one: Remove rendered only on a
// `managed === true` row, and every checkout on the box was hand-cloned. The
// guard was protecting something real — tearing down a checkout and its
// credentials that this page never created and knows nothing about — so the
// answer changes from "not at all" to "yes, once you have been told exactly
// what this page does not know". That acknowledgement is a parameter of the
// MECHANICS, not a UI-only confirm dialog: #2714's MCP tool calls
// `removeProject` directly, and a guard that lives in the browser would not
// exist for it.

describe('removing a project this page did not add (#2713)', () => {
  it('still refuses without the acknowledgement, and touches nothing', async () => {
    const res = await h.remove('handmade');
    expect(res.status).toBe(409);
    expect(ok(res).error).toContain('was not added through this page');
    // …and it names the next step, rather than being a dead end: what removing
    // it anyway would do, and the flag that says you know.
    expect(ok(res).detail).toContain('acknowledgeUnmanaged');
    expect(ok(res).detail).toContain('revokes no token');
    expect(h.state.windows).toContain('handmade');
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'handmade'))).toBe(false);
  });

  it('removes it WITH the acknowledgement: stops the session, marks it, revokes nothing', async () => {
    // Two projects, because the guarantee that matters is about the OTHER one:
    // a revoke that took every sibling with it would pass a one-project test.
    await h.add({ url: 'https://github.com/mdopp/alpha.git' });
    const alphaSecret = h.recordedSecret('alpha');
    const before = await h.stored();

    const res = await h.removeAnyway('handmade');
    expect(res.status).toBe(200);
    const body = ok(res);
    expect(body.removed.name).toBe('handmade');
    // No token of its own to take back, and the payload SAYS so rather than
    // reporting a revoke that did not happen.
    expect(body.removed.tokenId).toBeNull();
    expect(body.removed.managed).toBe(false);
    expect(body.removed.tokenRevoked).toBe(false);
    expect(body.removed.mcpEntryRemoved).toBe(false);
    expect(body.removed.checkoutDeleted).toBe(false);

    // Its session is down and stays down across the 300s reconcile.
    expect(h.state.windows).not.toContain('handmade');
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'handmade'))).toBe(true);

    // NOTHING was revoked — not the sibling's token, not the container's own.
    expect(await h.stored()).toHaveLength(before.length);
    expect((await h.tokens.verifyToken(alphaSecret))?.scopes).toEqual(['read']);
    expect((await h.tokens.verifyToken(h.parent.secret))?.id).toBe(h.parent.token.id);
    // The sibling's session and MCP entry are untouched.
    expect(h.state.windows).toContain('alpha');
    expect(h.localEntries().map(([p]) => path.basename(p))).toEqual(['alpha']);
  });

  it('deletes no files — the hand-cloned checkout and its work survive', async () => {
    fs.writeFileSync(path.join(h.workspace, 'handmade', 'uncommitted.txt'), 'work in progress');
    expect((await h.removeAnyway('handmade')).status).toBe(200);
    expect(fs.existsSync(path.join(h.workspace, 'handmade', '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(h.workspace, 'handmade', 'uncommitted.txt'), 'utf-8')).toBe('work in progress');
  });

  it('never runs `claude mcp remove` on a checkout whose entry it did not write', async () => {
    await h.removeAnyway('handmade');
    const mcpCalls = h.state.calls.filter(c => c.file === 'claude' && c.args[1] === 'remove');
    expect(mcpCalls).toEqual([]);
  });

  it('the acknowledgement does NOT bypass the other refusals', async () => {
    // Not there at all is still a 404, and a traversing name is still a 400 —
    // "I acknowledge" is about ownership, not about anything else.
    expect((await h.removeAnyway('never-existed')).status).toBe(404);
    expect((await request(h.port, 'DELETE',
      '/api/projects?name=..%2F..%2Fetc&acknowledgeUnmanaged=1', ADMIN)).status).toBe(400);
  });

  it('a FAILED ownership read is still Unknown, not "unmanaged" — even with the acknowledgement', async () => {
    // The three-state rule: `null` is "we could not look", and removing on the
    // strength of a failed read would be exactly the guess this UI refuses.
    fs.writeFileSync(h.claudeJson, '{ not json');
    const res = await h.removeAnyway('handmade');
    expect(res.status).toBe(500);
    expect(ok(res).error).toContain('could not tell whether');
    expect(h.state.windows).toContain('handmade');
    expect(fs.existsSync(path.join(h.workspace, '.claude-dev', 'no-autostart', 'handmade'))).toBe(false);
  });

  it('an anonymous acknowledged DELETE still stops nothing', async () => {
    const res = await h.removeAnyway('handmade', {});
    expect(res.status).toBe(401);
    expect(h.state.windows).toContain('handmade');
  });
});

describe('the panel confirms an unmanaged removal by naming what it does not know (#2713, DOM)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const handmade = () => project({ name: 'handmade', path: '/workspace/handmade', managed: false });

  it('does not send the DELETE on the first click — it asks first', async () => {
    const { root, calls } = await mountPanel(payload([handmade()]));
    (root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    expect(calls.find(c => c.init?.method === 'DELETE')).toBeUndefined();
    expect(root.querySelector('.projects-confirm')).not.toBeNull();
  });

  it('names each thing this page does not know, and what it will and will not touch', async () => {
    const { root } = await mountPanel(payload([handmade()]));
    (root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));

    const confirm = root.querySelector('.projects-confirm')!;
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    const unknowns = [...confirm.querySelectorAll('.projects-confirm-unknown')].map(n => n.textContent ?? '');
    expect(unknowns).toHaveLength(3);
    // The three specific unknowns the issue asks to be spelled out.
    expect(unknowns.join(' ')).toContain('no child token');
    expect(unknowns.join(' ')).toContain('no ServiceBay MCP entry');
    expect(unknowns.join(' ')).toContain('uncommitted');

    // What HAPPENS, and what is LEFT ALONE — both said out loud.
    const will = confirm.querySelector('.projects-confirm-will')!.textContent ?? '';
    expect(will).toContain('stop its Claude session');
    expect(will).toContain('auto-start');
    const wont = confirm.querySelector('.projects-confirm-wont')!.textContent ?? '';
    expect(wont).toContain('/workspace/handmade');
    expect(wont).toContain('revoke');
    expect(wont).toContain('other project');
  });

  it('sends the acknowledged DELETE only after the second, explicit click', async () => {
    const { root, calls } = await mountPanel(payload([handmade()]), {
      status: 200,
      body: {
        removed: {
          name: 'handmade', path: '/workspace/handmade', managed: false, tokenId: null,
          tokenRevoked: false, mcpEntryRemoved: false, session: { running: false }, checkoutDeleted: false,
        },
        warnings: [],
      },
    });
    (root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    (root.querySelector('button[data-project-remove-confirm="handmade"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));

    const del = calls.find(c => c.init?.method === 'DELETE')!;
    expect(del.url).toBe('/api/projects?name=handmade&acknowledgeUnmanaged=1');
    // The headline does not claim a revoke that never happened.
    const result = root.querySelector('.projects-result')!.textContent ?? '';
    expect(result).not.toContain('Revoked token');
    expect(result).toContain('no token of its own to revoke');
    expect(result).toContain('/workspace/handmade');
  });

  it('cancelling sends nothing at all', async () => {
    const { root, calls } = await mountPanel(payload([handmade()]));
    (root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    (root.querySelector('.projects-confirm-cancel') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    expect(calls.find(c => c.init?.method === 'DELETE')).toBeUndefined();
    expect(root.querySelector('.projects-confirm')).toBeNull();
    // The button is usable again, not left disabled by the cancelled attempt.
    expect((root.querySelector('button[data-project-remove="handmade"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a MANAGED row still removes on the first click — no extra step where nothing is unknown', async () => {
    const { root, calls } = await mountPanel(payload([project()]), {
      status: 200,
      body: {
        removed: {
          name: 'alpha', path: '/workspace/alpha', managed: true, tokenId: 'abcd1234',
          tokenRevoked: true, mcpEntryRemoved: true, session: { running: false }, checkoutDeleted: false,
        },
        warnings: [],
      },
    });
    (root.querySelector('button[data-project-remove="alpha"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
    expect(root.querySelector('.projects-confirm')).toBeNull();
    expect(calls.find(c => c.init?.method === 'DELETE')!.url).toBe('/api/projects?name=alpha');
  });

  it('an UNKNOWN row offers no confirmation to reach at all — the button stays disabled', async () => {
    const { root, calls } = await mountPanel(payload([project({ managed: null })]));
    const remove = root.querySelector('button[data-project-remove="alpha"], .projects-action .projects-remove') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    remove.click();
    await new Promise(r => setTimeout(r, 0));
    expect(root.querySelector('.projects-confirm')).toBeNull();
    expect(calls.find(c => c.init?.method === 'DELETE')).toBeUndefined();
  });
});
