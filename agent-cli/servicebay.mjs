#!/usr/bin/env node
/**
 * ServiceBay agent CLI (#2906, slice 1 of #2903).
 *
 * A coding agent's four tools are read/write/edit/bash — the shell IS the
 * access path, so ServiceBay ships one. This file is the whole client:
 *
 *   - **No build step, no dependency.** `node:` builtins only, no import of
 *     anything under `packages/`, no `npm install`. Delivery (#2908) is a git
 *     checkout dropped on the box the way the assist catalog is (ADR 0014), so
 *     the file must run exactly as it lies in the repo: `node servicebay.mjs
 *     services`. Anything that needs a transpile or a `node_modules` breaks
 *     that, permanently and silently.
 *   - **One seam, not three.** `templates/claude-dev/config-ui/server.mjs` and
 *     solarisbay's `pi-web-project` are two hand-maintained clients of the same
 *     routes, ageing apart. #2910 folds them onto this. That is why `VERBS`
 *     below is a *declarative table* rather than a function per verb: it is the
 *     contract those callers depend on, and #2907 pins it against the real
 *     routes so a route rename breaks the CLI instead of rotting it.
 *
 * ## The token never travels in argv
 *
 * There is deliberately **no `--token` flag**, and passing one is a usage
 * error. `/proc/<pid>/cmdline` is world-readable and an agent container has
 * real user logins on it, so a secret reaches a process through a file or the
 * environment — never an argument. Same rule, same reason as `gh auth login
 * --with-token` reading stdin in `config-ui/server.mjs` (#2681).
 *
 * ## Errors name the scope, not the status
 *
 * ServiceBay's REST gate answers a refused Bearer with a flat
 * `401 {"error":"Authentication required"}` — deliberately opaque, and useless
 * to an agent trying to work out what to ask for. So each verb *declares* the
 * scope it needs (the ladder in `packages/backend/src/lib/auth/apiScope.ts`)
 * and the CLI reports that instead of the raw status. A 403 carries the
 * server's own `Forbidden: '<scope>' scope required`, which is parsed and
 * relayed verbatim.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default base URL: the pod-crossing name from ADR 0007, never a LAN IP. */
export const DEFAULT_BASE_URL = 'http://host.containers.internal:5888';

const enc = encodeURIComponent;

/** Trim a body to something an agent can read without scrolling forever. */
function clip(value, max = 4000) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters, use --json for all of it)` : text;
}

function line(...parts) {
  return parts.filter(p => p !== '' && p !== undefined && p !== null).join('  ');
}

/**
 * The verb table — THE contract.
 *
 * Each entry declares everything a caller (or #2907's contract test) needs
 * without executing anything:
 *   `scope`   the ApiScope this verb requires; quoted back in every auth error
 *   `method`  / `path(args, options)` the exact route it speaks
 *   `reads`   the top-level response fields `text()` actually consumes, so a
 *             route that stops returning one is a red rather than a blank line
 *   `text`    the human rendering; `--json` bypasses it entirely
 */
export const VERBS = {
  services: {
    summary: 'list the services installed on the box',
    usage: 'services [--node <name>]',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['node'],
    path: (_args, opts) => `/api/services${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    reads: ['name', 'status', 'activeState'],
    text: body => {
      const list = Array.isArray(body) ? body : [];
      if (list.length === 0) return 'no services';
      return list
        .map(s => line(String(s?.name ?? '?').padEnd(24), String(s?.activeState ?? s?.status ?? '?')))
        .join('\n');
    },
  },

  service: {
    summary: 'show one service — its unit file, pod manifest and config',
    usage: 'service <name> [--node <name>]',
    scope: 'read',
    method: 'GET',
    positionals: ['name'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.name)}${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    reads: ['serviceFile', 'yamlFile'],
    text: body => {
      const parts = [];
      if (body?.serviceFile) parts.push(`--- unit ---\n${clip(body.serviceFile)}`);
      if (body?.yamlFile) parts.push(`--- pod manifest ---\n${clip(body.yamlFile)}`);
      return parts.length ? parts.join('\n\n') : 'no files returned for this service';
    },
  },

  diagnose: {
    summary: 'run the box diagnosis and read the probe results',
    // A POST that writes nothing — it only inspects state, which is why `read`
    // is the right scope (same shape as /api/install/plan).
    scope: 'read',
    method: 'POST',
    usage: 'diagnose [--node <name>]',
    positionals: [],
    options: ['node'],
    path: () => '/api/system/diagnose',
    body: (_args, opts) => (opts.node ? { node: opts.node } : {}),
    reads: ['probes'],
    text: body => {
      const probes = Array.isArray(body?.probes) ? body.probes : [];
      if (probes.length === 0) return 'no probes returned';
      return probes
        .map(p => line(String(p?.status ?? '?').padEnd(8), String(p?.id ?? p?.name ?? '?').padEnd(28), String(p?.message ?? '')))
        .join('\n');
    },
  },

  logs: {
    summary: 'fetch a service’s unit and podman logs',
    usage: 'logs <service> [--node <name>]',
    scope: 'read',
    method: 'GET',
    positionals: ['service'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.service)}/logs${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    reads: ['serviceLogs', 'podmanLogs'],
    text: body => {
      const parts = [];
      if (body?.serviceLogs) parts.push(`--- service ---\n${clip(body.serviceLogs, 8000)}`);
      if (body?.podmanLogs) parts.push(`--- podman ---\n${clip(body.podmanLogs, 8000)}`);
      return parts.length ? parts.join('\n\n') : 'no logs returned';
    },
  },

  health: {
    summary: 'read the configured health checks and their last result',
    usage: 'health',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: [],
    path: () => '/api/health/checks',
    reads: ['name', 'lastResult'],
    text: body => {
      const list = Array.isArray(body) ? body : Array.isArray(body?.checks) ? body.checks : [];
      if (list.length === 0) return 'no health checks';
      return list
        .map(c => line(String(c?.lastResult?.status ?? 'pending').padEnd(8), String(c?.name ?? '?')))
        .join('\n');
    },
  },

  assists: {
    summary: 'list the assist catalog (ADRs, recipes, guides, footguns)',
    usage: 'assists [--query <text>] [--kind <kind>]',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['query', 'kind'],
    path: (_args, opts) => {
      const qs = [];
      if (opts.query) qs.push(`query=${enc(opts.query)}`);
      if (opts.kind) qs.push(`kind=${enc(opts.kind)}`);
      return `/api/assists${qs.length ? `?${qs.join('&')}` : ''}`;
    },
    reads: ['assists'],
    text: body => {
      const list = Array.isArray(body?.assists) ? body.assists : [];
      if (list.length === 0) return 'no assists';
      return list
        .map(a => line(String(a?.id ?? '?').padEnd(36), String(a?.kind ?? '').padEnd(10), String(a?.whenToUse ?? a?.title ?? '')))
        .join('\n');
    },
  },

  assist: {
    summary: 'print one assist in full (frontmatter + body)',
    usage: 'assist <id>',
    scope: 'read',
    method: 'GET',
    positionals: ['id'],
    options: [],
    path: args => `/api/assists/${enc(args.id)}`,
    reads: ['content'],
    text: body => (typeof body?.content === 'string' ? body.content : 'assist returned no content'),
  },
};

/**
 * Read the ServiceBay token the way the container is given it.
 *
 * `SERVICEBAY_MCP_TOKEN_FILE` is the path the entrypoint writes — a mode-0400
 * file, because the environment is readable by other accounts on the container.
 * The plain env var is the fallback for running by hand. One-for-one with
 * `readServicebayToken` in `templates/claude-dev/config-ui/server.mjs`; #2910
 * collapses the two.
 */
export function readToken(env, readFile) {
  const file = env.SERVICEBAY_MCP_TOKEN_FILE;
  if (file) {
    try {
      return String(readFile(file)).trim();
    } catch {
      return '';
    }
  }
  return String(env.SERVICEBAY_MCP_TOKEN || '').trim();
}

export function baseUrl(env) {
  return String(env.SERVICEBAY_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function usage() {
  const rows = Object.values(VERBS).map(v => `  ${v.usage.padEnd(38)} ${v.summary}`);
  return [
    'servicebay — read the box from a shell.',
    '',
    'Usage: node servicebay.mjs <verb> [args] [--json]',
    '',
    'Verbs:',
    ...rows,
    '',
    'Every verb accepts --json for machine-readable output.',
    '',
    'Environment:',
    '  SERVICEBAY_MCP_TOKEN_FILE  path to the token file (preferred; mode 0400)',
    '  SERVICEBAY_MCP_TOKEN       the token itself (fallback, for running by hand)',
    `  SERVICEBAY_API_URL         base URL (default ${DEFAULT_BASE_URL})`,
    '',
    'The token is never a command-line argument: /proc/<pid>/cmdline is world-readable',
    'and this container has real user logins on it.',
  ].join('\n');
}

/** Argument shapes the CLI refuses outright, and why. */
const FORBIDDEN_FLAGS = new Map([
  ['--token', 'a token must not travel in argv (/proc/<pid>/cmdline is world-readable) — use SERVICEBAY_MCP_TOKEN_FILE or SERVICEBAY_MCP_TOKEN'],
  ['--password', 'a password must not travel in argv — this CLI authenticates with a scoped API token only'],
  ['--secret', 'a secret must not travel in argv — use SERVICEBAY_MCP_TOKEN_FILE'],
]);

/**
 * Split argv into `{ verb, args, options, json }`.
 * Returns `{ error }` instead of throwing so `run` stays a pure function.
 */
export function parseArgs(argv) {
  const [verbName, ...rest] = argv;
  if (!verbName || verbName === 'help' || verbName === '--help' || verbName === '-h') {
    return { help: true };
  }
  const verb = VERBS[verbName];
  if (!verb) return { error: `unknown verb \`${verbName}\`` };

  const positionals = [];
  const options = {};
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const bare = token.split('=')[0];
    if (FORBIDDEN_FLAGS.has(bare)) return { error: `${bare} is not accepted: ${FORBIDDEN_FLAGS.get(bare)}` };
    if (token === '--json') { json = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!verb.options.includes(name)) return { error: `\`${verbName}\` has no option \`--${name}\` (usage: ${verb.usage})` };
      const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (value === undefined) return { error: `--${name} needs a value (usage: ${verb.usage})` };
      options[name] = value;
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length !== verb.positionals.length) {
    return { error: `\`${verbName}\` takes ${verb.positionals.length} argument(s) (usage: ${verb.usage})` };
  }
  const args = {};
  verb.positionals.forEach((name, i) => { args[name] = positionals[i]; });
  return { verbName, verb, args, options, json };
}

/**
 * Turn an auth refusal into a message that names the SCOPE.
 *
 * A bare `401 Authentication required` tells an agent nothing it can act on.
 * The verb knows the scope it needs; a 403 additionally carries the server's
 * own `Forbidden: '<scope>' scope required`, which we prefer when present.
 */
function scopeRefusal(verbName, verb, status, body) {
  const serverSaid = typeof body?.error === 'string' ? body.error : '';
  const named = /'([a-z]+)' scope required/.exec(serverSaid);
  const required = named ? named[1] : verb.scope;
  const message = status === 403
    ? `the token is authenticated but under-scoped for \`${verbName}\`: it needs the \`${required}\` scope. ServiceBay says: ${serverSaid || 'Forbidden'}.`
    : `ServiceBay refused the token for \`${verbName}\`. This verb needs the \`${verb.scope}\` scope; the token presented was rejected, so it is either not valid (revoked or expired) or does not hold \`${verb.scope}\`.`;
  return { code: 'SCOPE', status, requiredScope: required, message };
}

function fail(verbName, error, json) {
  const payload = { ok: false, verb: verbName ?? null, error };
  const exitCode = error.code === 'USAGE' ? 2 : error.code === 'SCOPE' || error.code === 'NO_TOKEN' ? 3 : 1;
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : '',
    stderr: json ? '' : `servicebay: ${error.message}\n`,
  };
}

/**
 * Run one invocation. Pure: every effect is injected, nothing is written to
 * `process`, so the whole verb table is unit-testable against a fake server.
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const readFile = deps.readFile ?? (p => fs.readFileSync(p, 'utf-8'));

  const parsed = parseArgs(argv);
  if (parsed.help) return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' };
  if (parsed.error) return fail(null, { code: 'USAGE', message: `${parsed.error}\n\n${usage()}` }, false);

  const { verbName, verb, args, options, json } = parsed;

  const token = readToken(env, readFile);
  if (!token) {
    return fail(verbName, {
      code: 'NO_TOKEN',
      requiredScope: verb.scope,
      message: `no ServiceBay API token found, so \`${verbName}\` cannot authenticate. This verb needs a token with the \`${verb.scope}\` scope. `
        + 'Point SERVICEBAY_MCP_TOKEN_FILE at the token file this container was given (a mode-0400 file), or set SERVICEBAY_MCP_TOKEN. '
        + 'The token is never passed as an argument: /proc/<pid>/cmdline is world-readable.',
    }, json);
  }

  const url = `${baseUrl(env)}${verb.path(args, options)}`;
  const init = {
    method: verb.method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (verb.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(verb.body(args, options));
  }

  let response;
  try {
    response = await doFetch(url, init);
  } catch (err) {
    return fail(verbName, {
      code: 'NETWORK',
      message: `could not reach ServiceBay at ${baseUrl(env)}: ${err?.message || err}. Set SERVICEBAY_API_URL if the box is somewhere else.`,
    }, json);
  }

  const text = await response.text().catch(() => '');
  let body = null;
  let parseFailed = false;
  if (text) {
    try { body = JSON.parse(text); } catch { parseFailed = true; }
  }

  if (response.status === 401 || response.status === 403) {
    return fail(verbName, scopeRefusal(verbName, verb, response.status, body), json);
  }

  if (!response.ok) {
    const detail = (typeof body?.error === 'string' && body.error) || clip(text, 300) || `HTTP ${response.status}`;
    return fail(verbName, {
      code: response.status === 404 ? 'NOT_FOUND' : 'HTTP',
      status: response.status,
      message: `\`${verbName}\` failed: HTTP ${response.status} — ${detail}`,
    }, json);
  }

  if (parseFailed || (text && body === null)) {
    return fail(verbName, {
      code: 'BAD_JSON',
      status: response.status,
      message: `\`${verbName}\` got a ${response.status} whose body is not JSON: ${clip(text, 300)}`,
    }, json);
  }

  const payload = { ok: true, verb: verbName, data: body };
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : `${verb.text(body)}\n`,
    stderr: '',
  };
}

/* c8 ignore start — process wiring; `run` above is what the tests drive. */
export async function main(argv = process.argv.slice(2)) {
  const result = await run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
/* c8 ignore stop */
