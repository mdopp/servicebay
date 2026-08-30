#!/usr/bin/env node
/**
 * claude-dev configuration UI — the SHELL (#2678, epic #2674).
 *
 * A dependency-free Node HTTP server that ships inside the claude-dev image
 * and serves the container's own configuration UI. It is the foundation the
 * four follow-up units (#2679 project list, #2680 add/remove a project,
 * #2681 GitHub device flow, #2682 repair/restart buttons) build into, so the
 * three seams they need are named here rather than left to be inferred:
 *
 *   SEAM 1 — WHERE A PANEL MOUNTS.  `public/panels/index.js` is the panel
 *     manifest: a panel is an ES module exporting `{ id, title, mount(root) }`
 *     and is listed in that file's `PANELS` array. `public/shell.js` builds the
 *     nav from the array and calls `mount()` into `<main id="panel-root">`.
 *     An empty manifest renders the shell's own empty state. No server change
 *     is needed to add a panel.
 *
 *   SEAM 2 — HOW IT AUTHENTICATES.  There is no login form and no second
 *     credential. The UI is reached only through nginx + Authelia forward-auth
 *     (`CLAUDE_DEV_CONFIG_SUBDOMAIN` in variables.json), which replaces any
 *     client-supplied `Remote-*` headers with the ones Authelia returned. This
 *     server therefore treats `Remote-User` as the identity and REFUSES every
 *     request that carries none — see `authorizeRequest`. It is a gate on the
 *     whole surface (page, assets and API alike), not just on the API, so a
 *     future panel cannot accidentally publish an ungated route. Authorization
 *     reuses the group that already governs claude-dev access,
 *     `CLAUDE_DEV_LDAP_GROUP` (default `admins`) — Authelia's own wildcard rule
 *     is `one_factor` for `group:family`, so without this check every household
 *     account would reach the dev box's configuration.
 *
 *   SEAM 3 — HOW IT TALKS TO THE CONTAINER / TO SERVICEBAY.  `API_ROUTES` is
 *     the route table; `'GET /api/projects'` (#2679) sits next to
 *     `'GET /api/session'` and got the auth gate for free. Anything that needs
 *     ServiceBay's own API uses `ctx.servicebay` — the READ-ONLY `sb_…` token
 *     minted for this container at install time (`SERVICEBAY_MCP_TOKEN`,
 *     #2673), the SAME credential the entrypoint wires as Claude Code's MCP
 *     server. Do NOT mint a second one. It stays server-side: the browser is
 *     told only whether it is configured, never its value.
 *
 * Run: `node server.mjs` (all configuration via env, see `configFromEnv`).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Identity headers Authelia's auth-request returns and nginx re-emits on the
 *  upstream request (`AUTHELIA_LOCATION_HEADERS` in the ServiceBay backend). */
export const REMOTE_USER_HEADER = 'remote-user';
export const REMOTE_GROUPS_HEADER = 'remote-groups';
export const REMOTE_NAME_HEADER = 'remote-name';
export const REMOTE_EMAIL_HEADER = 'remote-email';

/** Read the Authelia identity off a request's headers. Node lower-cases
 *  incoming header names and comma-joins repeats, so both are handled. */
export function readIdentity(headers = {}) {
  const one = (name) => {
    const raw = headers[name];
    return String(Array.isArray(raw) ? raw.join(',') : (raw ?? '')).trim();
  };
  return {
    user: one(REMOTE_USER_HEADER),
    groups: one(REMOTE_GROUPS_HEADER).split(',').map(g => g.trim()).filter(Boolean),
    name: one(REMOTE_NAME_HEADER),
    email: one(REMOTE_EMAIL_HEADER),
  };
}

/**
 * The gate. Fail-closed by construction: an absent, empty or whitespace-only
 * `Remote-User` is a request that did NOT come through Authelia, and the
 * answer is 401 — never a rendered shell. A signed-in user outside
 * `requiredGroup` gets 403.
 *
 * Returns `{ ok, status, reason, identity }`; `reason` is safe to show, it
 * names the missing header or the required group, never a credential.
 */
export function authorizeRequest(headers = {}, requiredGroup = '') {
  const identity = readIdentity(headers);
  if (!identity.user) {
    return {
      ok: false,
      status: 401,
      reason: 'no Authelia identity on this request (Remote-User is empty) — '
        + 'this UI is only reachable through the reverse proxy',
      identity,
    };
  }
  if (requiredGroup && !identity.groups.includes(requiredGroup)) {
    return {
      ok: false,
      status: 403,
      reason: `signed in as "${identity.user}", which is not in the "${requiredGroup}" group`,
      identity,
    };
  }
  return { ok: true, status: 200, reason: '', identity };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Resolve a URL pathname to a file inside `publicDir`, or `null`.
 *
 * `path.resolve` collapses `..` BEFORE the containment check, so an escape
 * attempt (`/../../etc/passwd`, or its percent-encoded spelling) resolves
 * outside `publicDir` and is rejected rather than served.
 */
export function resolveStaticFile(pathname, publicDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(publicDir, '.' + rel);
  const root = path.resolve(publicDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!CONTENT_TYPES[path.extname(resolved)]) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

/* ───────────────────────── the project list (#2679) ──────────────────────────
 *
 * Three independent facts, read from three independent places — all of them
 * server-side, because a browser can see none of them:
 *
 *   CHECKOUTS — a top-level directory of $DEV_HOME (/workspace) holding a
 *     `.git` entry. That is exactly `discover_repos`' rule in
 *     docker-entrypoint.sh; diverging from it would make the panel describe a
 *     different set of projects than the one the container reconciles.
 *
 *   SESSIONS — a tmux window named after the checkout, in the shared `claude`
 *     session (start-claude.sh). tmux is the only authority: a claude process
 *     without a window is not a session anyone can attach to.
 *
 *   MCP ENTRIES — Claude Code's `~/.claude.json`. `mcpServers` at the top level
 *     is USER scope (inherited by every checkout — today's entrypoint writes
 *     exactly one there); `projects["<abs path>"].mcpServers` is LOCAL scope;
 *     a `.mcp.json` inside the checkout is PROJECT scope.
 *
 * Each source reports its own ok/error, and that split is the whole point. A
 * checkout with no session and a checkout whose session state could not be READ
 * must not render identically. So when a source fails, every project's field
 * for it is `null` — "unknown" — never `false`, and the failure itself travels
 * in `sources` so the panel can say so out loud. A failure to list the
 * checkouts has no list left to render at all, so it is the one failure that
 * fails the whole response (HTTP 500) instead of returning an empty list.
 */

/** Sessions live in tmux; this is the only place the CLI is invoked. */
function defaultRunTmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** tmux's way of saying "nothing is running" — an ANSWER, not a broken read. */
const TMUX_NOTHING_RUNNING = /no server running|no such session|session not found|can't find session/i;

/** Top-level git checkouts of `devHome`, sorted. Throws if the dir is unreadable. */
export function listCheckouts(devHome, fsImpl = fs) {
  return fsImpl.readdirSync(devHome, { withFileTypes: true })
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    // `.git` is a directory in a normal clone and a file in a worktree; the
    // entrypoint's `[ -e "${d}.git" ]` accepts both, so this must too.
    .filter(e => fsImpl.existsSync(path.join(devHome, e.name, '.git')))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Window names in the shared tmux session.
 *
 * An idle box has no tmux server at all, and `list-windows` then exits 1. That
 * is the honest answer "no sessions are running" and yields `[]`. Anything else
 * — tmux missing, a timeout, a permission problem — is a read that FAILED and
 * throws, so the caller can say "unknown" instead of "nothing".
 */
export function readTmuxWindows(tmuxSession, runTmux = defaultRunTmux) {
  let out;
  try {
    out = runTmux(['list-windows', '-t', tmuxSession, '-F', '#W']);
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    if (TMUX_NOTHING_RUNNING.test(stderr) || TMUX_NOTHING_RUNNING.test(String(err?.message ?? ''))) return [];
    throw new Error(stderr.trim() || err?.message || 'tmux could not be queried');
  }
  return String(out).split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * MCP servers Claude Code knows about: `{ user: [names], byPath: { path: [names] } }`.
 * A missing `~/.claude.json` means "nothing configured yet" and is a legitimate
 * empty answer; an unreadable or malformed one is a failed read and throws.
 */
export function readMcpEntries(homeDir, readFile = (p) => fs.readFileSync(p, 'utf-8')) {
  const file = path.join(homeDir, '.claude.json');
  let raw;
  try {
    raw = readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { user: [], byPath: {} };
    throw new Error(`could not read ${file}: ${err?.message || err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err?.message || err}`);
  }
  const names = (v) => (v && typeof v === 'object' ? Object.keys(v) : []);
  const byPath = {};
  for (const [p, entry] of Object.entries(parsed?.projects ?? {})) byPath[p] = names(entry?.mcpServers);
  return { user: names(parsed?.mcpServers), byPath };
}

/** PROJECT-scope servers: the checkout's own tracked `.mcp.json`. */
function readProjectScopeServers(checkoutPath, readFile) {
  const file = path.join(checkoutPath, '.mcp.json');
  let raw;
  try {
    raw = readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`could not read ${file}: ${err?.message || err}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? Object.keys(parsed.mcpServers) : [];
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err?.message || err}`);
  }
}

/**
 * The whole payload behind `GET /api/projects`.
 * `{ ok: false, error }` when the checkout scan itself failed; otherwise
 * `{ ok: true, workspace, projects, sources }`.
 */
export function collectProjects({
  devHome = '/workspace',
  homeDir = devHome,
  tmuxSession = 'claude',
  fsImpl = fs,
  runTmux = defaultRunTmux,
  readFile = (p) => fs.readFileSync(p, 'utf-8'),
} = {}) {
  let names;
  try {
    names = listCheckouts(devHome, fsImpl);
  } catch (err) {
    return { ok: false, error: `could not list the checkouts in ${devHome}: ${err?.message || err}` };
  }

  let windows = null;
  let sessionsError = '';
  try {
    windows = readTmuxWindows(tmuxSession, runTmux);
  } catch (err) {
    sessionsError = String(err?.message || err);
  }

  let mcpByName = null;
  let mcpError = '';
  try {
    const entries = readMcpEntries(homeDir, readFile);
    mcpByName = {};
    for (const name of names) {
      const scopes = [];
      const servers = new Set();
      const add = (scope, list) => {
        if (!list.length) return;
        scopes.push(scope);
        for (const s of list) servers.add(s);
      };
      add('user', entries.user);
      add('local', entries.byPath[path.join(devHome, name)] ?? []);
      add('project', readProjectScopeServers(path.join(devHome, name), readFile));
      mcpByName[name] = { configured: servers.size > 0, scopes, servers: [...servers].sort() };
    }
  } catch (err) {
    mcpByName = null;
    mcpError = String(err?.message || err);
  }

  const projects = names.map(name => ({
    name,
    path: path.join(devHome, name),
    // The entrypoint only auto-starts a checkout carrying a CLAUDE.md
    // (`select_autostart_repos`), so this is what tells "no session because
    // it is not a development target" apart from "no session, something broke".
    developmentTarget: fsImpl.existsSync(path.join(devHome, name, 'CLAUDE.md')),
    session: windows ? { running: windows.includes(name) } : null,
    mcp: mcpByName ? mcpByName[name] : null,
  }));

  return {
    ok: true,
    workspace: devHome,
    projects,
    sources: {
      checkouts: { ok: true, detail: devHome },
      sessions: windows
        ? { ok: true, detail: `tmux session "${tmuxSession}"` }
        : { ok: false, error: sessionsError },
      mcp: mcpByName
        ? { ok: true, detail: path.join(homeDir, '.claude.json') }
        : { ok: false, error: mcpError },
    },
  };
}

/**
 * SEAM 3 — the API route table. Key is `"<METHOD> <pathname>"`; the handler
 * gets `(req, res, ctx)` and runs only AFTER the auth gate passed, with
 * `ctx.identity` already resolved. Add a follow-up unit's routes here.
 */
export const API_ROUTES = {
  /** Who am I, and what can this shell reach — no secrets in the payload. */
  'GET /api/session': (req, res, ctx) => {
    sendJson(res, 200, {
      user: ctx.identity.user,
      name: ctx.identity.name,
      email: ctx.identity.email,
      groups: ctx.identity.groups,
      // Whether the shell can call ServiceBay on the operator's behalf. The
      // token itself never leaves the server (SEAM 3).
      servicebay: { configured: Boolean(ctx.servicebay.token), url: ctx.servicebay.url },
    });
  },

  /** The project list (#2679) — checkouts, their sessions, their MCP entries. */
  'GET /api/projects': (req, res, ctx) => {
    const result = ctx.projects();
    // A read that FAILED is an error, never an empty list — the two must not
    // be indistinguishable to the panel.
    if (!result.ok) return sendJson(res, 500, { error: result.error });
    sendJson(res, 200, {
      workspace: result.workspace,
      projects: result.projects,
      sources: result.sources,
    });
  },
};

function securityHeaders(res) {
  // No inline script or style anywhere in public/, so `default-src 'self'`
  // holds without a nonce.
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Every response is identity-scoped; never let a proxy or the browser
  // hand one operator's shell to the next request.
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'] });
  res.end(payload);
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * Build the server. `requiredGroup: ''` disables the group check (the identity
 * check is NOT optional — there is no switch that turns it off).
 */
export function createConfigUiServer({
  requiredGroup = '',
  publicDir = path.join(HERE, 'public'),
  servicebay = { url: '', token: '' },
  // Options for `collectProjects` (devHome, homeDir, tmuxSession, and the
  // injectable fs/tmux readers the tests drive it with).
  projects = {},
  log = console.log,
} = {}) {
  return http.createServer((req, res) => {
    securityHeaders(res);

    const url = new URL(req.url || '/', 'http://config-ui.invalid');
    const pathname = url.pathname;

    // SEAM 2 — one gate, ahead of every route and every asset.
    const auth = authorizeRequest(req.headers, requiredGroup);
    if (!auth.ok) {
      log(`claude-dev config-ui: refused ${req.method} ${pathname} — ${auth.reason}`);
      // Deliberately plain text, not the shell: a refused request must not
      // return anything that looks like a rendered UI.
      return sendText(res, auth.status, `${auth.status === 401 ? 'Unauthorized' : 'Forbidden'} — ${auth.reason}\n`);
    }

    // Read lazily, per request: the panel's whole job is to show what is true
    // NOW, not what was true when the server booted.
    const ctx = { identity: auth.identity, servicebay, projects: () => collectProjects(projects) };

    const route = API_ROUTES[`${req.method} ${pathname}`];
    if (route) return route(req, res, ctx);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'no such route' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method Not Allowed\n');
    }

    const file = resolveStaticFile(pathname, publicDir);
    if (!file) return sendText(res, 404, 'Not Found\n');
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * Read the ServiceBay token. `SERVICEBAY_MCP_TOKEN_FILE` is the path the
 * entrypoint uses — a mode-0400 file, because argv and the environment are
 * both readable by every other account on this container. The plain env var
 * is the fallback for running the server by hand.
 */
export function readServicebayToken(env = process.env, readFile = (p) => fs.readFileSync(p, 'utf-8')) {
  const file = env.SERVICEBAY_MCP_TOKEN_FILE;
  if (file) {
    try {
      return readFile(file).trim();
    } catch {
      return '';
    }
  }
  return (env.SERVICEBAY_MCP_TOKEN || '').trim();
}

/** All configuration comes from the env the template's pod manifest sets. */
export function configFromEnv(env = process.env) {
  return {
    port: parseInt(env.CLAUDE_DEV_CONFIG_PORT || '8790', 10),
    // Inside the pod netns; the pod manifest publishes it on the host's
    // 127.0.0.1 only, so nginx is the sole reachable path in.
    host: env.CLAUDE_DEV_CONFIG_BIND || '0.0.0.0',
    requiredGroup: (env.CLAUDE_DEV_LDAP_GROUP || 'admins').trim(),
    servicebay: {
      url: env.SERVICEBAY_API_URL || 'http://host.containers.internal:5888',
      token: readServicebayToken(env),
    },
    // The `dev` user's HOME *is* the shared workspace (docker-entrypoint.sh
    // exports HOME=$DEV_HOME), which is why both default to the same path —
    // but they are separate settings because `~/.claude.json` and the checkouts
    // are separate concerns.
    projects: {
      devHome: env.CLAUDE_DEV_WORKSPACE || '/workspace',
      homeDir: env.HOME || env.CLAUDE_DEV_WORKSPACE || '/workspace',
      tmuxSession: env.CLAUDE_TMUX_SESSION || 'claude',
    },
  };
}

export function startFromEnv(env = process.env, log = console.log) {
  const cfg = configFromEnv(env);
  const server = createConfigUiServer({
    requiredGroup: cfg.requiredGroup,
    servicebay: cfg.servicebay,
    projects: cfg.projects,
    log,
  });
  server.listen(cfg.port, cfg.host, () => {
    log(`claude-dev config-ui: listening on ${cfg.host}:${cfg.port}, `
      + `requiring Authelia identity in group "${cfg.requiredGroup || '(any)'}"; `
      + `ServiceBay API token ${cfg.servicebay.token ? 'present' : 'ABSENT'}.`);
  });
  return server;
}

// Only when executed directly — importing this file (tests) must not listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnv();
}
