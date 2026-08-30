/**
 * claude-dev config UI — the GitHub connection (#2681, epic #2674).
 *
 * Acceptance on the issue, and what each one is worth only if it is asserted a
 * particular way:
 *
 *   1. "Connect GitHub" runs the device flow and lands a WORKING gh/git
 *      credential with no shell access. "Working" has to be EXERCISED, so the
 *      fake `gh` below only names an account when the token it is asked about
 *      is byte-for-byte the one GitHub handed back — a test that merely checked
 *      "a file appeared" would pass with the wrong bytes in it, which is the
 *      exact failure mode this panel exists to end.
 *
 *   2. The UI shows accurate connected/not-connected status and the account
 *      name. The NEGATIVES carry this one: a missing credential must read as
 *      not-connected, and an unreadable or failed check must read as UNKNOWN —
 *      not as either of the other two. Every one of those is a separate case
 *      here, at the API and in the DOM, because on screen they are one careless
 *      branch apart and getting it wrong sends someone to redo a connection
 *      that already works.
 *
 *   3. The stored credential has the correct owner (`dev`) and mode (0600) from
 *      the start. Asserted against `fs.statSync` of the file that was actually
 *      written — and the case where the tightening FAILS is asserted too, since
 *      #2672 shipped precisely because this file spent months at mode 0777 on a
 *      container with real user logins on it.
 *
 * Two invariants that are not on the issue but would be quiet disasters:
 *
 *   • the access token never travels as a command-line argument (/proc is
 *     world-readable here) and never reaches a log line or an HTTP response;
 *   • the `device_code` — the half that redeems the token — never reaches the
 *     browser, which only ever gets an opaque flow id.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_UI_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui');
const SERVER_MJS = path.join(CONFIG_UI_DIR, 'server.mjs');
const PANEL_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'github.js');
const MANIFEST_JS = path.join(CONFIG_UI_DIR, 'public', 'panels', 'index.js');

const ADMIN: Record<string, string> = { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' };

// Obvious fakes. Neither is a credential shape the secret scan knows, and
// neither has ever been valid anywhere.
const ACCESS_TOKEN = 'device-flow-access-token-for-tests';
const DEVICE_CODE = 'device-code-that-must-stay-server-side';
const USER_CODE = 'ABCD-1234';

type Res = { status: number; body: string };

function request(port: number, method: string, pathname: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { ...ADMIN, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
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

/** `execFileSync`'s shape for a non-zero EXIT (as opposed to a failed spawn). */
const exited = (code: number, stderr: string) =>
  Object.assign(new Error('Command failed'), { status: code, stderr, stdout: '' });

type GhEnv = Record<string, string | undefined>;
type GhCall = { args: string[]; env: GhEnv; input?: string };

/**
 * The container in miniature: a throwaway gh config dir plus a `gh` that really
 * reads and writes it, so "connected" is a fact about the stored bytes.
 */
function makeContainer() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dev-gh-home-'));
  const configDir = path.join(homeDir, '.config', 'gh');
  const hostsFile = path.join(configDir, 'hosts.yml');

  const state = {
    account: 'mdopp',
    /** The only token GitHub will accept — see `gh api user` below. */
    validToken: ACCESS_TOKEN,
    calls: [] as GhCall[],
    /** Force one specific failure out of `gh api user`. */
    apiFails: null as null | (() => never),
    loginFails: '' as string,
    setupGitFails: '' as string,
  };

  const runCommand = (file: string, args: string[], opts: { env?: GhEnv; input?: string } = {}) => {
    const env: GhEnv = opts.env ?? {};
    state.calls.push({ args: [file, ...args].slice(1), env, input: opts.input });
    if (file !== 'gh') throw new Error(`unexpected command: ${file}`);
    const dir = String(env.GH_CONFIG_DIR ?? '');

    if (args[0] === 'auth' && args[1] === 'login') {
      if (state.loginFails) throw exited(1, state.loginFails);
      const token = String(opts.input ?? '').trim();
      if (!token) throw exited(1, 'gh: no token supplied on standard input');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(hostsFile, `github.com:\n    oauth_token: ${token}\n`, { mode: 0o600 });
      return '';
    }
    if (args[0] === 'auth' && args[1] === 'setup-git') {
      if (state.setupGitFails) throw exited(1, state.setupGitFails);
      fs.writeFileSync(path.join(homeDir, '.gitconfig'),
        '[credential "https://github.com"]\n\thelper = !/usr/bin/gh auth git-credential\n');
      return '';
    }
    if (args[0] === 'api' && args[1] === 'user') {
      if (state.apiFails) state.apiFails();
      // The real gh prefers GH_TOKEN over the stored credential; so does this.
      if (env.GH_TOKEN) return 'someone-elses-account\n';
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf-8');
      } catch {
        throw exited(4, 'To get started with GitHub CLI, please run:  gh auth login\n');
      }
      const token = /oauth_token:\s*(\S+)/.exec(raw)?.[1] ?? '';
      if (token !== state.validToken) throw exited(1, 'gh: Bad credentials (HTTP 401)\n');
      return `${state.account}\n`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };

  return { homeDir, configDir, hostsFile, state, runCommand };
}

/** GitHub's two device-flow endpoints, scripted answer by answer. */
function makeGithub() {
  const script: Array<Record<string, unknown>> = [];
  const seen: Array<{ url: string; params: Record<string, string> }> = [];
  const doFetch = async (url: string, init: { body?: string }) => {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    seen.push({ url: String(url), params });
    const next = script.shift() ?? { status: 500, body: { error: 'no scripted answer left' } };
    const status = Number(next.status ?? 200);
    const text = JSON.stringify(next.body ?? {});
    return { status, ok: status < 400, text: async () => text } as unknown as Response;
  };
  return { script, seen, doFetch };
}

const DEVICE_CODE_ANSWER = {
  status: 200,
  body: {
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  },
};

async function startServer(container: ReturnType<typeof makeContainer>, doFetch: unknown, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const mod = await import(/* @vite-ignore */ SERVER_MJS);
  const server = mod.createConfigUiServer({
    requiredGroup: 'admins',
    servicebay: { url: 'http://host.containers.internal:5888', token: '' },
    projects: { devHome: container.homeDir, homeDir: container.homeDir, runTmux: () => '' },
    github: {
      homeDir: container.homeDir,
      configDir: container.configDir,
      clientId: 'test-client-id',
      runCommand: container.runCommand,
      doFetch,
      env: {},
      ...extra,
    },
    log: (line: string) => logs.push(line),
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, logs, port: (server.address() as AddressInfo).port };
}

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ───────────── acceptance 1: the flow lands a WORKING credential ─────────────

describe('the device flow (acceptance 1)', () => {
  it('hands GitHub the client id and scopes, and returns only the USER code to the browser', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(DEVICE_CODE_ANSWER);
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const res = await request(port, 'POST', '/api/github/device');
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);

    expect(gh.seen[0].url).toBe('https://github.com/login/device/code');
    expect(gh.seen[0].params.client_id).toBe('test-client-id');
    expect(gh.seen[0].params.scope).toContain('repo');
    // `workflow` is not decorative: without it a push touching .github/workflows
    // is rejected, which is most of what the sessions on this box push.
    expect(gh.seen[0].params.scope).toContain('workflow');

    expect(body.userCode).toBe(USER_CODE);
    expect(body.verificationUri).toBe('https://github.com/login/device');
    expect(typeof body.flowId).toBe('string');
    // The half that redeems the token stays here.
    expect(res.body).not.toContain(DEVICE_CODE);
    expect(body).not.toHaveProperty('deviceCode');
    expect(body).not.toHaveProperty('device_code');
  });

  it('polls until GitHub approves, then stores a credential that really answers as the account', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(
      DEVICE_CODE_ANSWER,
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: ACCESS_TOKEN, token_type: 'bearer' } },
    );
    const { server, port, logs } = await startServer(c, gh.doFetch);
    servers.push(server);

    const { flowId } = JSON.parse((await request(port, 'POST', '/api/github/device')).body);

    const pending = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId })).body);
    expect(pending.state).toBe('pending');
    // Nothing was written while the operator had not approved it.
    expect(fs.existsSync(c.hostsFile)).toBe(false);

    const done = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId })).body);
    expect(done.state).toBe('connected');
    // EXERCISED: the fake gh only names an account when the stored token is the
    // one GitHub returned, so this asserts the credential works, not that a
    // file exists.
    expect(done.status.connected).toBe(true);
    expect(done.status.account).toBe('mdopp');
    expect(done.warnings).toEqual([]);
    expect(fs.readFileSync(c.hostsFile, 'utf-8')).toContain(ACCESS_TOKEN);

    // git, not just gh — `--with-token` alone leaves `git push` prompting.
    expect(fs.readFileSync(path.join(c.homeDir, '.gitconfig'), 'utf-8'))
      .toContain('gh auth git-credential');

    // And the status route, asked cold afterwards, agrees.
    const status = JSON.parse((await request(port, 'GET', '/api/github')).body);
    expect(status).toMatchObject({ connected: true, account: 'mdopp' });

    // The token never left the server, in either direction.
    expect(JSON.stringify(done)).not.toContain(ACCESS_TOKEN);
    expect(logs.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(logs.join('\n')).toContain('connected GitHub as "mdopp"');
  });

  it('never puts the token on a command line — it goes in on stdin', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(DEVICE_CODE_ANSWER, { status: 200, body: { access_token: ACCESS_TOKEN } });
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const { flowId } = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    await request(port, 'POST', '/api/github/device/poll', { flowId });

    // /proc/<pid>/cmdline is world-readable and this container has real user
    // logins on it, so argv is a broadcast channel.
    for (const call of c.state.calls) {
      expect(call.args.join(' ')).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(ACCESS_TOKEN);
    }
    const login = c.state.calls.find(call => call.args[0] === 'auth' && call.args[1] === 'login')!;
    expect(login.args).toContain('--with-token');
    expect(login.input).toBe(`${ACCESS_TOKEN}\n`);
  });

  it('names every non-success outcome of the flow instead of failing vaguely', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(
      DEVICE_CODE_ANSWER, { status: 200, body: { error: 'expired_token' } },
      DEVICE_CODE_ANSWER, { status: 200, body: { error: 'access_denied' } },
    );
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const first = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    const expired = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId: first.flowId })).body);
    expect(expired.state).toBe('expired');

    const second = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    const denied = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId: second.flowId })).body);
    expect(denied.state).toBe('denied');

    // A spent flow is gone: the device code cannot be replayed.
    const replay = await request(port, 'POST', '/api/github/device/poll', { flowId: second.flowId });
    expect(replay.status).toBe(404);
    expect(fs.existsSync(c.hostsFile)).toBe(false);
  });

  it('refuses to report a connection when GitHub refuses to start one', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push({ status: 401, body: { error: 'unauthorized_client', error_description: 'no such app' } });
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const res = await request(port, 'POST', '/api/github/device');
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).detail).toContain('no such app');
  });
});

// ─────────── acceptance 3: owner and mode of the stored credential ───────────

describe('the stored credential (acceptance 3)', () => {
  it('lands mode 0600, owned by the process that wrote it, and says so', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(DEVICE_CODE_ANSWER, { status: 200, body: { access_token: ACCESS_TOKEN } });
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const { flowId } = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    const done = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId })).body);

    // Measured off the real file, not off what the server claims.
    expect(fs.statSync(c.hostsFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(c.configDir).mode & 0o777).toBe(0o700);
    expect(done.status.credential).toMatchObject({
      path: c.hostsFile, exists: true, mode: '0600', private: true, ownedByServer: true,
    });
    expect(done.warnings).toEqual([]);
  });

  it('says the file is still open rather than claiming a mode it could not set', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const gh = makeGithub();
    gh.script.push(DEVICE_CODE_ANSWER, { status: 200, body: { access_token: ACCESS_TOKEN } });
    // A root-owned hosts.yml left over from the hand-made era (#2672): `dev` can
    // write it because it is 0777, and cannot chmod it because it is not the
    // owner. Reporting 0600 here would be a lie about a live token.
    const fsImpl = {
      ...fs,
      chmodSync: (target: string) => {
        if (String(target).endsWith('hosts.yml')) {
          throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
        }
      },
      statSync: (target: string) => {
        const real = fs.statSync(target);
        if (String(target).endsWith('hosts.yml')) {
          return { ...real, mode: (real.mode & ~0o777) | 0o777, uid: real.uid + 1 };
        }
        return real;
      },
    };
    const { server, port } = await startServer(c, gh.doFetch, { fsImpl });
    servers.push(server);

    const { flowId } = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    const done = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId })).body);

    expect(done.state).toBe('connected');
    expect(done.status.credential).toMatchObject({ mode: '0777', private: false, ownedByServer: false });
    expect(done.warnings.join(' ')).toContain('could not set mode 0600');
    expect(done.warnings.join(' ')).toContain('other logins on this container can read the token');
  });

  it('says so when git could not be wired, instead of reporting a clean success', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    c.state.setupGitFails = 'gh: could not write the git configuration';
    const gh = makeGithub();
    gh.script.push(DEVICE_CODE_ANSWER, { status: 200, body: { access_token: ACCESS_TOKEN } });
    const { server, port } = await startServer(c, gh.doFetch);
    servers.push(server);

    const { flowId } = JSON.parse((await request(port, 'POST', '/api/github/device')).body);
    const done = JSON.parse((await request(port, 'POST', '/api/github/device/poll', { flowId })).body);

    expect(done.state).toBe('connected');
    expect(done.status.connected).toBe(true);
    expect(done.warnings.join(' ')).toContain('git was not wired to it');
  });
});

// ───── acceptance 2: connected / not connected / unknown are three answers ────

describe('the status route (acceptance 2)', () => {
  const ask = async (prepare: (c: ReturnType<typeof makeContainer>) => void) => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    prepare(c);
    const { server, port } = await startServer(c, makeGithub().doFetch);
    servers.push(server);
    return JSON.parse((await request(port, 'GET', '/api/github')).body);
  };

  it('a missing credential is NOT connected — a definite no, with the reason', async () => {
    const body = await ask(() => { /* nothing was ever stored */ });
    expect(body.connected).toBe(false);
    expect(body.detail).toContain('no GitHub credential is stored');
    expect(body.account).toBe('');
    expect(body.credential).toMatchObject({ exists: false, mode: null, private: null });
  });

  it('a credential GitHub rejects is NOT connected, and says which of the two nos it is', async () => {
    const body = await ask(c => {
      fs.mkdirSync(c.configDir, { recursive: true });
      fs.writeFileSync(c.hostsFile, 'github.com:\n    oauth_token: a-revoked-token\n', { mode: 0o600 });
    });
    expect(body.connected).toBe(false);
    expect(body.detail).toContain('GitHub rejected it');
    // The file IS there — which is exactly why "a file exists" is not a status.
    expect(body.credential.exists).toBe(true);
  });

  it('a check that could not RUN is unknown, never "not connected"', async () => {
    const body = await ask(c => {
      c.state.apiFails = () => {
        // A failed spawn carries an errno and no exit status.
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      };
    });
    expect(body.connected).toBe(null);
    expect(body.detail).toContain('could not be run');
  });

  it('a check that timed out or failed for an unrecognised reason is unknown', async () => {
    const body = await ask(c => {
      c.state.apiFails = () => { throw exited(1, 'error connecting to api.github.com: dial tcp: lookup failed'); };
    });
    expect(body.connected).toBe(null);
    expect(body.detail).toContain('api.github.com');
  });

  it('an unreadable credential file leaves owner and mode unknown, not assumed', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const fsImpl = {
      ...fs,
      statSync: (target: string) => {
        if (String(target).endsWith('hosts.yml')) {
          throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
        }
        return fs.statSync(target);
      },
    };
    const { server, port } = await startServer(c, makeGithub().doFetch, { fsImpl });
    servers.push(server);

    const body = JSON.parse((await request(port, 'GET', '/api/github')).body);
    expect(body.credential).toMatchObject({ exists: null, mode: null, private: null, ownedByServer: null });
    expect(body.credential.error).toContain('EACCES');
  });

  it('ignores GH_TOKEN in the environment, so status describes the STORED credential', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const { server, port } = await startServer(c, makeGithub().doFetch, {
      env: { GH_TOKEN: 'a-token-from-somewhere-else', GITHUB_TOKEN: 'another-one' },
    });
    servers.push(server);

    const body = JSON.parse((await request(port, 'GET', '/api/github')).body);
    // With GH_TOKEN honoured this would report "connected as someone-elses-account"
    // while hosts.yml is empty — a green light for a credential this page does
    // not have.
    expect(body.connected).toBe(false);
    expect(body.account).toBe('');
  });

  it('is behind the same auth gate as everything else — no Authelia identity, no answer', async () => {
    const c = makeContainer();
    dirs.push(c.homeDir);
    const { server, port } = await startServer(c, makeGithub().doFetch);
    servers.push(server);

    const res = await new Promise<Res>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/github', method: 'GET' }, r => {
        let text = '';
        r.setEncoding('utf-8');
        r.on('data', ch => { text += ch; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(401);
  });
});

// ────────────────────── the classifier, case by case ─────────────────────────

describe('classifyGithubStatus', () => {
  const load = async () => (await import(/* @vite-ignore */ SERVER_MJS)) as {
    classifyGithubStatus: (r: Record<string, unknown>) => { connected: boolean | null; account: string; detail: string };
    redactCredentials: (t: string) => string;
  };

  it('maps each gh outcome to exactly one of the three answers', async () => {
    const { classifyGithubStatus } = await load();
    const cases: Array<[Record<string, unknown>, boolean | null]> = [
      [{ exitCode: 0, stdout: 'mdopp\n', stderr: '', spawnError: '' }, true],
      [{ exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', spawnError: '' }, false],
      [{ exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.', spawnError: '' }, false],
      [{ exitCode: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)', spawnError: '' }, false],
      [{ exitCode: null, stdout: '', stderr: '', spawnError: 'ETIMEDOUT' }, null],
      [{ exitCode: 1, stdout: '', stderr: 'something nobody has seen before', spawnError: '' }, null],
      // A zero exit with no account is a broken read, not a nameless success.
      [{ exitCode: 0, stdout: '\n', stderr: '', spawnError: '' }, null],
    ];
    for (const [result, expected] of cases) {
      expect(classifyGithubStatus(result).connected, JSON.stringify(result)).toBe(expected);
    }
  });

  it('masks anything token-shaped before it can reach a log line or a response', async () => {
    const { classifyGithubStatus, redactCredentials } = await load();
    const leak = `gho_${'A1b2C3d4E5f6G7h8J9k0'}`;
    expect(redactCredentials(`sent ${leak} upstream`)).not.toContain(leak);
    const out = classifyGithubStatus({ exitCode: 1, stdout: '', stderr: `weird failure using ${leak}`, spawnError: '' });
    expect(out.connected).toBe(null);
    expect(out.detail).not.toContain(leak);
    expect(out.detail).toContain('<redacted>');
  });
});

// ──────────────────────────── the rendered panel ─────────────────────────────

async function mountPanel(handlers: Record<string, () => { ok?: boolean; status?: number; body: unknown }>) {
  document.body.replaceChildren();
  const root = document.createElement('main');
  root.id = 'panel-root';
  document.body.append(root);

  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const handler = handlers[String(url)];
    if (!handler) throw new Error(`no handler for ${url}`);
    const answer = handler();
    const status = answer.status ?? 200;
    return { ok: answer.ok ?? status < 400, status, json: async () => answer.body };
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  const mod = await import(/* @vite-ignore */ PANEL_JS);
  const dispose = mod.default.mount(root, { session: { user: 'mdopp' } });
  await new Promise(r => setTimeout(r, 0));
  return { root, dispose, fetchMock };
}

const statusPayload = (over: Record<string, unknown>) => ({
  connected: null,
  account: '',
  detail: '',
  hostname: 'github.com',
  credential: { path: '/workspace/.config/gh/hosts.yml', exists: false, mode: null, ownedByServer: null, private: null },
  ...over,
});

describe('the GitHub panel renders the three answers apart (acceptance 2, DOM)', () => {
  it('is registered in the panel manifest, so the shell shows it', async () => {
    vi.resetModules();
    const manifest = await import(/* @vite-ignore */ MANIFEST_JS);
    const ids = manifest.PANELS.map((p: { id: string }) => p.id);
    expect(ids).toContain('github');
    expect(manifest.PANELS.find((p: { id: string }) => p.id === 'github').title).toBe('GitHub');
  });

  it('connected: names the account and describes the stored file', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({
        body: statusPayload({
          connected: true,
          account: 'mdopp',
          credential: { path: '/workspace/.config/gh/hosts.yml', exists: true, mode: '0600', ownedByServer: true, private: true },
        }),
      }),
    });
    const box = root.querySelector('[data-github]')!;
    expect(box.getAttribute('data-github')).toBe('connected');
    expect(box.textContent).toContain('Connected');
    expect(box.textContent).toContain('mdopp');
    expect(root.querySelector('[data-credential]')!.getAttribute('data-credential')).toBe('private');
    expect(root.querySelector('[data-credential]')!.textContent).toContain('mode 0600');
  });

  it('not connected: a definite no, with the reason, and nothing that reads as unknown', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({
        body: statusPayload({ connected: false, detail: 'no GitHub credential is stored for this container' }),
      }),
    });
    const box = root.querySelector('[data-github]')!;
    expect(box.getAttribute('data-github')).toBe('disconnected');
    expect(box.textContent).toContain('Not connected');
    expect(box.textContent).toContain('no GitHub credential is stored');
    expect(box.textContent).not.toContain('Unknown');
    expect(root.querySelector('[data-credential]')!.getAttribute('data-credential')).toBe('absent');
  });

  it('unknown: says the check did not complete, and does NOT render as not-connected', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({
        body: statusPayload({ connected: null, detail: 'the GitHub CLI could not be run: ENOENT' }),
      }),
    });
    const box = root.querySelector('[data-github]')!;
    expect(box.getAttribute('data-github')).toBe('unknown');
    expect(box.textContent).toContain('Unknown');
    expect(box.textContent).toContain('NOT a report that GitHub is disconnected');
    expect(box.textContent).not.toContain('Not connected');
  });

  it('a failing status route is unknown too — a broken read is not a negative answer', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({ status: 500, body: { error: 'the container is not answering' } }),
    });
    const box = root.querySelector('[data-github]')!;
    expect(box.getAttribute('data-github')).toBe('unknown');
    expect(box.textContent).toContain('the container is not answering');
  });

  it('an uninspectable credential file leaves the file line unknown, not "absent"', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({
        body: statusPayload({
          connected: null,
          credential: { path: '/workspace/.config/gh/hosts.yml', exists: null, mode: null, ownedByServer: null, private: null, error: 'EACCES' },
        }),
      }),
    });
    const line = root.querySelector('[data-credential]')!;
    expect(line.getAttribute('data-credential')).toBe('unknown');
    expect(line.textContent).toContain('could not be inspected');
  });
});

describe('the Connect button drives the flow from the browser (acceptance 1, DOM)', () => {
  it('shows the one-time code, polls, and reports the account it landed', async () => {
    let connected = false;
    let polls = 0;
    const { root } = await mountPanel({
      '/api/github': () => ({
        body: connected
          ? statusPayload({
            connected: true,
            account: 'mdopp',
            credential: { path: '/workspace/.config/gh/hosts.yml', exists: true, mode: '0600', ownedByServer: true, private: true },
          })
          : statusPayload({ connected: false, detail: 'no GitHub credential is stored for this container' }),
      }),
      '/api/github/device': () => ({
        status: 201,
        body: {
          flowId: 'flow-1', userCode: USER_CODE, verificationUri: 'https://github.com/login/device',
          interval: 5, expiresAt: Date.now() + 900_000, scopes: 'repo read:org gist workflow',
        },
      }),
      '/api/github/device/poll': () => {
        polls += 1;
        if (polls < 2) return { body: { state: 'pending', interval: 5 } };
        connected = true;
        return {
          body: {
            state: 'connected',
            status: statusPayload({
              connected: true, account: 'mdopp',
              credential: { path: '/workspace/.config/gh/hosts.yml', exists: true, mode: '0600', ownedByServer: true, private: true },
            }),
            warnings: [],
          },
        };
      },
    });

    // Fake timers only AFTER mount: the panel's own first load awaits a real
    // macrotask, and freezing the clock before that just hangs it.
    vi.useFakeTimers();
    (root.querySelector('.github-connect') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);

    // The operator can read the code and reach the page that takes it — that is
    // the whole "no shell access" claim.
    expect(root.querySelector('[data-user-code]')!.textContent).toBe(USER_CODE);
    expect((root.querySelector('.github-flow-link') as HTMLAnchorElement).href)
      .toBe('https://github.com/login/device');

    await vi.advanceTimersByTimeAsync(5000);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls).toBe(2);

    expect(root.querySelector('.github-result')!.textContent).toContain('Connected to GitHub as mdopp');
    expect(root.querySelector('[data-github]')!.getAttribute('data-github')).toBe('connected');
  });

  it('shows the warnings a connect returned as loudly as the success line', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({ body: statusPayload({ connected: false, detail: 'no GitHub credential is stored' }) }),
      '/api/github/device': () => ({
        status: 201,
        body: {
          flowId: 'flow-1', userCode: USER_CODE, verificationUri: 'https://github.com/login/device',
          interval: 5, expiresAt: Date.now() + 900_000, scopes: 'repo',
        },
      }),
      '/api/github/device/poll': () => ({
        body: {
          state: 'connected',
          status: statusPayload({ connected: true, account: 'mdopp' }),
          warnings: ['/workspace/.config/gh/hosts.yml is mode 0777 — other logins on this container can read the token.'],
        },
      }),
    });

    vi.useFakeTimers();
    (root.querySelector('.github-connect') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const result = root.querySelector('.github-result')!;
    expect(result.className).toContain('github-result-partial');
    expect(result.textContent).toContain('mode 0777');
  });

  it('an expired code says so and re-enables Connect rather than looking finished', async () => {
    const { root } = await mountPanel({
      '/api/github': () => ({ body: statusPayload({ connected: false, detail: 'no GitHub credential is stored' }) }),
      '/api/github/device': () => ({
        status: 201,
        body: {
          flowId: 'flow-1', userCode: USER_CODE, verificationUri: 'https://github.com/login/device',
          interval: 5, expiresAt: Date.now() + 900_000, scopes: 'repo',
        },
      }),
      '/api/github/device/poll': () => ({
        body: { state: 'expired', detail: 'the one-time code expired before it was entered on github.com' },
      }),
    });

    const connect = root.querySelector('.github-connect') as HTMLButtonElement;
    vi.useFakeTimers();
    connect.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);

    expect(root.querySelector('.github-error')!.textContent).toContain('expired');
    expect(connect.disabled).toBe(false);
  });
});
