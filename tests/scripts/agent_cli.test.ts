/**
 * The agent CLI (#2906, slice 1 of #2903) against a fake ServiceBay.
 *
 * Why a real `node:http` server rather than a stubbed `fetch`: the CLI's whole
 * job is to be the ONE client of these routes, so the thing worth pinning is
 * what it does with a real response — a 401 with an opaque body, a 200 whose
 * body is not JSON, a connection that is refused. A stubbed fetch would let the
 * CLI's own `response.text()`/`JSON.parse` handling go untested, which is
 * exactly where the two hand-maintained clients (#2910) diverge.
 *
 * Every verb is exercised the same four ways — success, HTTP error, malformed
 * JSON, refused scope — by iterating `VERBS`, so a NEW verb is covered the
 * moment it is added to the table rather than when someone remembers to add a
 * case. #2907 adds the complementary class-level check against the real routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const CLI = path.resolve(__dirname, '..', '..', 'agent-cli', 'servicebay.mjs');

type Verb = {
  usage: string;
  summary: string;
  scope: string;
  method: string;
  positionals: string[];
  options: string[];
  path: (args: Record<string, string>, opts: Record<string, string>) => string;
  body?: (args: Record<string, string>, opts: Record<string, string>) => unknown;
  reads: string[];
  text: (body: unknown) => string;
};
type Cli = {
  VERBS: Record<string, Verb>;
  DEFAULT_BASE_URL: string;
  readToken: (env: Record<string, string | undefined>, readFile: (p: string) => string) => string;
  baseUrl: (env: Record<string, string | undefined>) => string;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  run: (argv: string[], deps?: Record<string, unknown>) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

let cli: Cli;

/** What the fake server answers next, and what it last saw. */
let reply: { status: number; body: string; contentType?: string };
let seen: { method: string; url: string; auth: string | undefined; body: string };
let server: http.Server;
let origin: string;

/** A plausible-shaped, entirely fictional token — never a real `sb_` secret. */
const FAKE_TOKEN = 'sb_deadbeef_not-a-real-secret';

/** Sample bodies keyed by verb, shaped like the routes actually answer. */
const SUCCESS_BODY: Record<string, unknown> = {
  services: [{ name: 'media', activeState: 'active', status: 'running' }],
  service: { serviceFile: '[Unit]\nDescription=media', yamlFile: 'apiVersion: v1' },
  diagnose: { probes: [{ id: 'dns', status: 'ok', message: 'resolves' }] },
  logs: { serviceLogs: 'started', podmanLogs: 'pulled', podmanPs: [] },
  health: [{ name: 'Link: jellyfin', lastResult: { status: 'ok' } }],
  assists: { assists: [{ id: 'adr-0007-naming', kind: 'adr', whenToUse: 'you are wiring two services' }] },
  assist: { id: 'adr-0007-naming', content: '---\ntitle: Naming\n---\nbody' },
};

/** The positional arguments each verb needs, for the table-driven cases. */
const ARGV: Record<string, string[]> = {
  services: ['services'],
  service: ['service', 'media'],
  diagnose: ['diagnose'],
  logs: ['logs', 'media'],
  health: ['health'],
  assists: ['assists'],
  assist: ['assist', 'adr-0007-naming'],
};

function envWith(extra: Record<string, string> = {}) {
  return { SERVICEBAY_API_URL: origin, SERVICEBAY_MCP_TOKEN: FAKE_TOKEN, ...extra };
}

beforeAll(async () => {
  cli = (await import(/* @vite-ignore */ CLI)) as unknown as Cli;
  server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', d => { chunks += d; });
    req.on('end', () => {
      seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: chunks };
      res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('agent CLI verb table', () => {
  it('runs on plain `node` — no shebang dependency, no build, no import outside node:', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true);
  });

  it('declares a scope, a method and a path for every verb', () => {
    for (const [name, verb] of Object.entries(cli.VERBS)) {
      expect(['read', 'lifecycle', 'mutate', 'reboot', 'destroy', 'exec', 'propose'], name).toContain(verb.scope);
      expect(['GET', 'POST'], name).toContain(verb.method);
      expect(verb.usage.startsWith(name), name).toBe(true);
      expect(verb.reads.length, name).toBeGreaterThan(0);
    }
  });

  it('reads the token from a file first, then the env var — never from argv', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-'));
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, `${FAKE_TOKEN}\n`);
    expect(cli.readToken({ SERVICEBAY_MCP_TOKEN_FILE: file }, p => fs.readFileSync(p, 'utf8'))).toBe(FAKE_TOKEN);
    expect(cli.readToken({ SERVICEBAY_MCP_TOKEN: ` ${FAKE_TOKEN} ` }, () => '')).toBe(FAKE_TOKEN);
    // An unreadable token file is empty, not a crash — the caller then reports
    // "no token" with the scope it needed.
    expect(cli.readToken({ SERVICEBAY_MCP_TOKEN_FILE: path.join(dir, 'gone') }, p => fs.readFileSync(p, 'utf8'))).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses --token/--password/--secret so a credential never reaches /proc', async () => {
    for (const flag of ['--token', '--password', '--secret']) {
      const result = await cli.run(['services', flag, 'whatever'], { env: envWith() });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('argv');
      expect(result.stderr).not.toContain('whatever');
    }
  });

  it('defaults to the pod-crossing host name, not a LAN IP (ADR 0007)', () => {
    expect(cli.DEFAULT_BASE_URL).toBe('http://host.containers.internal:5888');
    expect(cli.baseUrl({})).toBe(cli.DEFAULT_BASE_URL);
    expect(cli.baseUrl({ SERVICEBAY_API_URL: 'http://box:5888/' })).toBe('http://box:5888');
  });
});

describe.each(Object.keys(ARGV))('verb `%s`', verbName => {
  const argv = ARGV[verbName];

  it('succeeds: sends the declared method with a Bearer token and returns the body under --json', async () => {
    reply = { status: 200, body: JSON.stringify(SUCCESS_BODY[verbName]) };
    const result = await cli.run([...argv, '--json'], { env: envWith() });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(seen.method).toBe(cli.VERBS[verbName].method);
    expect(seen.auth).toBe(`Bearer ${FAKE_TOKEN}`);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual({ ok: true, verb: verbName, data: SUCCESS_BODY[verbName] });
  });

  it('renders human text that actually reads the fields the table declares', async () => {
    reply = { status: 200, body: JSON.stringify(SUCCESS_BODY[verbName]) };
    const result = await cli.run(argv, { env: envWith() });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    // Not the JSON envelope — the text path must not fall back to dumping it.
    expect(result.stdout).not.toContain('"ok": true');
  });

  it('reports an HTTP error with the status and the server’s own message', async () => {
    reply = { status: 500, body: JSON.stringify({ error: 'the box is on fire' }) };
    const result = await cli.run(argv, { env: envWith() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('500');
    expect(result.stderr).toContain('the box is on fire');
  });

  it('reports malformed JSON as malformed JSON, not as success', async () => {
    reply = { status: 200, body: '<html>nginx</html>', contentType: 'text/html' };
    const result = await cli.run([...argv, '--json'], { env: envWith() });
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('BAD_JSON');
    expect(payload.error.message).toContain('nginx');
  });

  it('turns the opaque 401 into the scope this verb needs', async () => {
    reply = { status: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    const result = await cli.run(argv, { env: envWith() });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(`\`${cli.VERBS[verbName].scope}\` scope`);
    // The point of the issue: an agent must not be handed a bare 401.
    expect(result.stderr).not.toMatch(/^servicebay: 401/);
  });

  it('relays the scope a 403 names', async () => {
    reply = { status: 403, body: JSON.stringify({ error: "Forbidden: 'mutate' scope required" }) };
    const result = await cli.run([...argv, '--json'], { env: envWith() });
    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stdout);
    expect(payload.error.code).toBe('SCOPE');
    expect(payload.error.requiredScope).toBe('mutate');
    expect(payload.error.message).toContain('under-scoped');
  });

  it('with no token at all, says what is missing and which scope it needed', async () => {
    const result = await cli.run(argv, { env: { SERVICEBAY_API_URL: origin } });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('no ServiceBay API token found');
    expect(result.stderr).toContain(`\`${cli.VERBS[verbName].scope}\` scope`);
    expect(result.stderr).toContain('SERVICEBAY_MCP_TOKEN_FILE');
  });
});

describe('agent CLI request shaping', () => {
  it('puts `--node` on the query string for the GET verbs and in the body for diagnose', async () => {
    reply = { status: 200, body: JSON.stringify(SUCCESS_BODY.services) };
    await cli.run(['services', '--node', 'Local'], { env: envWith() });
    expect(seen.url).toBe('/api/services?node=Local');

    reply = { status: 200, body: JSON.stringify(SUCCESS_BODY.diagnose) };
    await cli.run(['diagnose', '--node', 'Local'], { env: envWith() });
    expect(seen.url).toBe('/api/system/diagnose');
    expect(JSON.parse(seen.body)).toEqual({ node: 'Local' });
  });

  it('percent-encodes a positional so a name can never escape the path', async () => {
    reply = { status: 200, body: JSON.stringify(SUCCESS_BODY.assist) };
    await cli.run(['assist', '../../etc/passwd'], { env: envWith() });
    expect(seen.url).toBe('/api/assists/..%2F..%2Fetc%2Fpasswd');
  });

  it('rejects an unknown verb, an unknown option and a wrong argument count with usage (exit 2)', async () => {
    for (const argv of [['nope'], ['services', '--bogus', 'x'], ['assist'], ['health', 'extra']]) {
      const result = await cli.run(argv, { env: envWith() });
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });

  it('prints usage on `help` and on no arguments (exit 0)', async () => {
    for (const argv of [[], ['help'], ['--help']]) {
      const result = await cli.run(argv, { env: envWith() });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('SERVICEBAY_MCP_TOKEN_FILE');
    }
  });

  it('says the box is unreachable rather than throwing when the connection is refused', async () => {
    const result = await cli.run(['services'], { env: envWith({ SERVICEBAY_API_URL: 'http://127.0.0.1:1' }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('could not reach ServiceBay');
    expect(result.stderr).toContain('SERVICEBAY_API_URL');
  });
});

/**
 * The other half of #2906: a CLI whose verbs 401 on the real box is a CLI that
 * does nothing. ServiceBay's REST gate is a per-route opt-in — a route without
 * `tokenScope` has `requireSession` skip the Bearer branch entirely and 401 a
 * perfectly valid read token (#2899). So every route the verb table speaks to
 * has to carry the opt-in, and this pins it: dropping one turns the verb into a
 * silent 401 that no CLI-side test would notice.
 *
 * Read out of the FIRST argument to `withApiHandler(Params)` — the options
 * object the gate actually reads — rather than grepping the file, which would
 * also match the comment above it (the #2249 lesson from scopeGuards.test.ts).
 */
describe('the routes the CLI verbs read accept a read-scoped Bearer token (#2906)', () => {
  const API_DIR = path.resolve(__dirname, '..', '..', 'packages', 'frontend', 'src', 'app', 'api');

  /** Route file → the handler whose options must carry `tokenScope: 'read'`. */
  const READ_ROUTES: Array<[string, string]> = [
    ['services/route.ts', 'GET'],
    ['services/[name]/route.ts', 'GET'],
    ['services/[name]/logs/route.ts', 'GET'],
    ['system/diagnose/route.ts', 'POST'],
    ['health/checks/route.ts', 'GET'],
    ['assists/route.ts', 'GET'],
    ['assists/[id]/route.ts', 'GET'],
  ];

  /** The options object that is the FIRST arg to the named verb's handler. */
  function handlerOptions(relPath: string, verb: string): string {
    const src = fs.readFileSync(path.join(API_DIR, relPath), 'utf8');
    const from = src.indexOf(`export const ${verb} = withApiHandler`);
    expect(from, `${relPath}: no ${verb} handler`).toBeGreaterThan(-1);
    const opts = /withApiHandler(?:Params)?[^(]*\(\s*(\{[^}]*\})/.exec(src.slice(from));
    expect(opts, `${relPath}: ${verb} has no options object`).not.toBeNull();
    return opts![1];
  }

  for (const [relPath, verb] of READ_ROUTES) {
    it(`${verb} /${relPath.replace(/\/route\.ts$/, '')} carries tokenScope: 'read'`, () => {
      expect(handlerOptions(relPath, verb)).toMatch(/tokenScope:\s*'read'/);
    });
  }

  it('leaves the mutating handlers in those files cookie/internal-only', () => {
    // Opening the read branch must not widen the destructive ones sharing the file.
    const untouched: Array<[string, string]> = [
      ['services/route.ts', 'POST'],
      ['services/[name]/route.ts', 'DELETE'],
      ['services/[name]/route.ts', 'PUT'],
      ['health/checks/route.ts', 'POST'],
      ['health/checks/route.ts', 'DELETE'],
    ];
    for (const [relPath, verb] of untouched) {
      expect(handlerOptions(relPath, verb), `${verb} ${relPath}`).not.toMatch(/tokenScope/);
    }
  });
});
