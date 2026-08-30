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
 *     the route table; `'GET /api/projects'` (#2679), its `POST`/`DELETE`
 *     siblings (#2680), the `/api/github` trio (#2681) and
 *     `'POST /api/projects/restart'` (#2682) sit next to
 *     `'GET /api/session'` and got the auth gate for free — a handler may be
 *     async. The Claude sign-in repair deliberately has NO route: it is a plain
 *     link at ServiceBay's own whitelisted terminal deep-link. Anything that needs
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
import { randomUUID } from 'node:crypto';
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
 * The MCP server name this UI writes per project (#2680), and the one the
 * entrypoint writes once at USER scope for every session
 * (`configure_mcp_server`). Deliberately the SAME name: Claude Code resolves
 * local scope ahead of user scope, so a project that was added here overrides
 * the shared container-wide credential with its own delegated child token
 * instead of exposing two ServiceBay servers with duplicate tools.
 */
export const PROJECT_MCP_SERVER = 'servicebay';

/** `sb_<id>_<secret>` — only the 8-hex id is ever pulled out of it. */
const SB_TOKEN_ID = /^sb_([0-9a-f]{8})_/;

/**
 * MCP servers Claude Code knows about:
 * `{ user: [names], byPath: { path: [names] }, delegatedByPath: { path: id } }`.
 *
 * `delegatedByPath` is the ownership record this UI runs on (#2680): the
 * LOCAL-scope `servicebay` entry's `Authorization: Bearer sb_<id>_…` header.
 * There is no second bookkeeping file on purpose — the MCP entry *is* the
 * record, so an entry can never point at a token that was never minted and a
 * minted token can never lack an entry. Only the id is extracted; the secret
 * stays in the file and never leaves this process.
 *
 * A missing `~/.claude.json` means "nothing configured yet" and is a legitimate
 * empty answer; an unreadable or malformed one is a failed read and throws.
 */
export function readMcpEntries(homeDir, readFile = (p) => fs.readFileSync(p, 'utf-8')) {
  const file = path.join(homeDir, '.claude.json');
  let raw;
  try {
    raw = readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { user: [], byPath: {}, delegatedByPath: {} };
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
  const delegatedByPath = {};
  for (const [p, entry] of Object.entries(parsed?.projects ?? {})) {
    byPath[p] = names(entry?.mcpServers);
    const authz = entry?.mcpServers?.[PROJECT_MCP_SERVER]?.headers?.Authorization;
    const id = typeof authz === 'string' ? SB_TOKEN_ID.exec(authz.replace(/^Bearer\s+/i, '')) : null;
    if (id) delegatedByPath[p] = id[1];
  }
  return { user: names(parsed?.mcpServers), byPath, delegatedByPath };
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
  let managedByName = null;
  let mcpError = '';
  try {
    const entries = readMcpEntries(homeDir, readFile);
    mcpByName = {};
    managedByName = {};
    for (const name of names) {
      // Was this project ADDED through this UI (#2680)? True iff it carries a
      // local-scope entry whose header names a delegated `sb_` token — that is
      // the only thing Remove is allowed to act on.
      managedByName[name] = Boolean(entries.delegatedByPath[path.join(devHome, name)]);
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
    managedByName = null;
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
    // `null` when the MCP read failed: we do not know whether this UI owns
    // this checkout, and offering Remove on a guess is exactly the assertion
    // nobody verified. Unknown is not "no".
    managed: managedByName ? managedByName[name] : null,
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

/* ─────────────────── add / remove a project (#2680) ─────────────────────────
 *
 * #2674's gap, stated plainly: "today a checkout only gets a session if a human
 * clones it by hand." Add closes it end to end — clone, `safe.directory`, a
 * DELEGATED child of this container's ServiceBay token, the project's own MCP
 * entry, the tmux session — and Remove takes exactly those back.
 *
 * Three design choices carry the acceptance criteria, so they are written down
 * rather than left to be inferred:
 *
 *   OWNERSHIP IS THE MCP ENTRY. A project is "ours" iff `~/.claude.json` holds
 *     a LOCAL-scope `servicebay` entry for it whose header names an `sb_`
 *     token. That single record is both the ownership flag and the token id,
 *     so token and entry cannot drift apart: no orphan is possible because
 *     there is nothing to orphan *from*. Remove refuses anything else — the
 *     hand-cloned checkouts other people are working in are untouchable.
 *
 *   REMOVE DELETES NO FILES. It revokes the token, drops the MCP entry and
 *     stops the session; the checkout stays on disk. The issue asks for
 *     exactly those three, and a one-click rm -rf of a working tree with
 *     uncommitted work in it is not a thing to add on inference. The bound is
 *     therefore structural: this module calls no filesystem-removal primitive
 *     on a checkout at all.
 *
 *   REMOVE IS DURABLE. The entrypoint re-reconciles every 300s and would
 *     restart the session it just stopped, so Remove drops a marker under
 *     `<devHome>/.claude-dev/no-autostart/<name>` that `select_autostart_repos`
 *     honours. Without it the button would report success and quietly undo
 *     itself minutes later.
 *
 * Ordering is chosen so a failure at any step leaves NOTHING orphaned:
 *   add    → revoke any previous child, mint, write the entry (revoke again if
 *            that write fails), then start the session;
 *   remove → revoke first, drop the entry second, so a failed revoke leaves a
 *            live token that is still recorded and can be retried.
 */

/**
 * Run a container-side CLI. Injectable so tests never need a real /workspace.
 *
 * `opts.input` is written to the child's stdin and is how a SECRET reaches a
 * CLI (`gh auth login --with-token`, #2681): argv is world-readable through
 * /proc and this container has real user logins on it, so a token must never
 * travel as an argument.
 */
function defaultRunCommand(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

/** One error shape for every CRUD step: an HTTP status plus a sayable reason. */
class ProjectError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * A project name is ONE path segment that is also a usable tmux window name.
 * Rejecting rather than sanitising is deliberate: a silently rewritten name
 * would not match the directory the operator then goes looking for.
 */
export function validateProjectName(name) {
  if (!name) return 'a project name is required';
  if (name.length > 64) return 'a project name may be at most 64 characters';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `"${name}" is not a usable project name — use letters, digits, ".", "_" and "-", starting with a letter or a digit`;
  }
  if (name === '.' || name === '..') return 'a project name may not be "." or ".."';
  return '';
}

/**
 * Only remotes git can fetch WITHOUT running a command we chose for it.
 * `ext::` (and `file://` pointing at a crafted repo) turn a URL into code
 * execution inside this container, so the scheme is allow-listed rather than
 * denied case by case. argv is already safe — every exec here is `execFile`
 * with an array — this guards the *remote helper*, not the shell.
 */
export function validateGitUrl(url) {
  if (!url) return 'a git URL is required to clone a new checkout';
  if (url.length > 512) return 'that git URL is implausibly long';
  if (/[\s\x00-\x1f]/.test(url)) return 'a git URL may not contain whitespace or control characters';
  if (!/^(https:\/\/|http:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(url)) {
    return 'only https://, http://, ssh:// and git@host:path remotes are accepted';
  }
  return '';
}

/** Turn `https://github.com/mdopp/servicebay.git` into `servicebay`. */
export function projectNameFromUrl(url) {
  const withoutQuery = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const last = withoutQuery.split(/[/:]/).pop() || '';
  return last.replace(/\.git$/i, '');
}

/** Where Remove records "do not auto-start this again" for the entrypoint. */
function noAutostartMarker(devHome, name) {
  return path.join(devHome, '.claude-dev', 'no-autostart', name);
}

/**
 * The tmux target for ONE project's window.
 *
 * The `=` is load-bearing, not decoration. Without it tmux resolves a window
 * name by exact match FIRST and then by PREFIX, so on the real box
 * `claude:solaris` resolves to `solarisbay` and `claude:servicebay` would
 * happily match `servicebay-templates` if the exact window were gone. A stop
 * aimed at one project would then take out a different one — the single worst
 * thing the stop/restart path could do. `=` makes tmux answer "can't find
 * window: <name>" instead, which is a refusal we can report.
 */
function windowTarget(tmuxSession, name) {
  return `${tmuxSession}:=${name}`;
}

/** tmux's way of saying "that window is not there" — an ANSWER, not a failure. */
const TMUX_NO_SUCH_WINDOW =
  /no server running|can't find window|window not found|no such window|can't find session|session not found/i;

/**
 * Stop EXACTLY one project's session. Returns `''` when the window is gone
 * (killed now, or never running), otherwise the reason it could not be stopped.
 *
 * Shared by Remove (#2680) and Restart (#2682) so there is ONE spelling of the
 * kill target — a second copy is how one of them would end up without the `=`.
 */
function stopSessionWindow(tmuxSession, name, runTmux) {
  try {
    runTmux(['kill-window', '-t', windowTarget(tmuxSession, name)]);
    return '';
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || '');
    if (TMUX_NO_SUCH_WINDOW.test(stderr)) return '';
    return stderr.slice(0, 200);
  }
}

/**
 * Start ONE project's session, with the same `start-claude` invocation Add
 * (#2680) uses. Returns `''` or the reason the CLI refused.
 *
 * `CLAUDE_START_NO_ATTACH` matters here: this process has no terminal, and
 * without it start-claude would `exec tmux attach` and never return.
 */
function startSessionWindow({ devHome, homeDir, tmuxSession, name, runCommand }) {
  try {
    runCommand('start-claude', ['--continue', '--allow-dangerously-skip-permissions', '--', name], {
      cwd: devHome,
      env: { ...process.env, HOME: homeDir, CLAUDE_START_NO_ATTACH: '1', CLAUDE_TMUX_SESSION: tmuxSession },
    });
    return '';
  } catch (err) {
    return String(err?.stderr || err?.message || err).slice(0, 200);
  }
}

/**
 * Ask TMUX whether one project's window is up — never the CLI that was just
 * run. `session` is `null` when tmux itself could not be read, because an
 * unverified `running: true` is the whole bug class this UI exists to end.
 */
function readSessionState(tmuxSession, name, runTmux) {
  try {
    return { session: { running: readTmuxWindows(tmuxSession, runTmux).includes(name) }, error: '' };
  } catch (err) {
    return { session: null, error: String(err?.message || err).slice(0, 200) };
  }
}

/** ServiceBay's own API, reached with the container's read-only parent token. */
async function servicebayFetch(servicebay, pathname, init, doFetch) {
  if (!servicebay?.token) {
    throw new ProjectError(503, 'this container holds no ServiceBay API token, so it cannot delegate one to a project');
  }
  const base = String(servicebay.url || '').replace(/\/+$/, '');
  let res;
  try {
    res = await doFetch(`${base}${pathname}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${servicebay.token}` },
    });
  } catch (err) {
    throw new ProjectError(502, `could not reach ServiceBay at ${base}: ${err?.message || err}`);
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, ok: res.ok, body, text };
}

/** Mint a read-only child of this container's token, bound to one project. */
async function delegateProjectToken(servicebay, name, doFetch) {
  const res = await servicebayFetch(servicebay, '/api/system/api-tokens/delegate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Read-only, like the parent: a project session that genuinely needs more
    // goes through `request_token`, which itself needs only `read`.
    body: JSON.stringify({ name: `claude-dev project ${name}`, scopes: ['read'] }),
  }, doFetch);
  if (!res.ok || typeof res.body?.secret !== 'string') {
    throw new ProjectError(502,
      `ServiceBay refused to delegate a token for "${name}"`,
      res.body?.error || res.text.slice(0, 200) || `HTTP ${res.status}`);
  }
  return { secret: res.body.secret, id: res.body.token?.id ?? '', scopes: res.body.token?.scopes ?? [] };
}

/**
 * Revoke one delegated child. `404` comes back as `alreadyGone` rather than an
 * error so a remove that failed halfway can be retried to completion — every
 * other refusal is surfaced, because "revoked nothing" must never read as
 * "revoked it".
 */
async function revokeProjectToken(servicebay, tokenId, doFetch) {
  const res = await servicebayFetch(servicebay,
    `/api/system/api-tokens/delegate?id=${encodeURIComponent(tokenId)}`, { method: 'DELETE' }, doFetch);
  if (res.status === 404) return { revoked: false, alreadyGone: true };
  if (!res.ok) {
    throw new ProjectError(502,
      `ServiceBay refused to revoke this project's token (${tokenId})`,
      res.body?.error || res.text.slice(0, 200) || `HTTP ${res.status}`);
  }
  return { revoked: true, alreadyGone: false };
}

/** The delegated token id recorded for one checkout, or `''`. Throws if the
 *  file could not be read — "we could not look" is not "not managed". */
function recordedTokenId(homeDir, checkoutPath, readFile) {
  return readMcpEntries(homeDir, readFile).delegatedByPath[checkoutPath] ?? '';
}

/**
 * Add a project. Returns the payload for `POST /api/projects`.
 *
 * An EXISTING checkout is adopted rather than refused: /workspace is full of
 * repos someone cloned by hand, and wiring one up is the same job as cloning a
 * new one. It is also what makes re-adding after a removal possible at all —
 * and re-add is where orphans would show up, so the first thing an adopt does
 * is revoke whatever child token the previous round recorded.
 */
export async function addProject(options, servicebay, input) {
  const {
    devHome = '/workspace',
    homeDir = devHome,
    tmuxSession = 'claude',
    fsImpl = fs,
    runTmux = defaultRunTmux,
    runCommand = defaultRunCommand,
    readFile = (p) => fs.readFileSync(p, 'utf-8'),
    doFetch = fetch,
  } = options ?? {};

  const url = String(input?.url ?? '').trim();
  const name = String(input?.name ?? '').trim() || projectNameFromUrl(url);
  const nameError = validateProjectName(name);
  if (nameError) throw new ProjectError(400, nameError);

  const checkoutPath = path.join(devHome, name);
  const exists = fsImpl.existsSync(checkoutPath);
  const isCheckout = exists && fsImpl.existsSync(path.join(checkoutPath, '.git'));
  if (exists && !isCheckout) {
    throw new ProjectError(409,
      `${checkoutPath} already exists and is not a git checkout — pick another name or clear it from a shell`);
  }

  const warnings = [];
  let cloned = false;
  if (!exists) {
    const urlError = validateGitUrl(url);
    if (urlError) throw new ProjectError(400, urlError);
    try {
      runCommand('git', ['clone', '--', url, checkoutPath], { cwd: devHome, env: { ...process.env, HOME: homeDir } });
    } catch (err) {
      throw new ProjectError(502, `git could not clone ${url}`, String(err?.stderr || err?.message || err).slice(0, 500));
    }
    cloned = true;
  }

  // Same registration the entrypoint does, same idempotent `--replace-all`
  // form — a root-owned checkout is unusable to `dev` without it.
  try {
    runCommand('git', ['config', '--global', '--replace-all', '--fixed-value',
      'safe.directory', checkoutPath, checkoutPath], { cwd: devHome, env: { ...process.env, HOME: homeDir } });
  } catch (err) {
    warnings.push(`git safe.directory could not be registered for ${checkoutPath}: ${String(err?.message || err).slice(0, 200)}`);
  }

  // Re-add must not leave the previous round's token behind (acceptance 3).
  const previousId = recordedTokenId(homeDir, checkoutPath, readFile);
  if (previousId) {
    const previous = await revokeProjectToken(servicebay, previousId, doFetch);
    if (previous.alreadyGone) warnings.push(`the previously recorded token ${previousId} was already gone`);
  }

  const token = await delegateProjectToken(servicebay, name, doFetch);
  const mcpUrl = `${String(servicebay.url || '').replace(/\/+$/, '')}/mcp`;
  try {
    // remove-then-add, like the entrypoint: idempotent across re-adds.
    try {
      runCommand('claude', ['mcp', 'remove', PROJECT_MCP_SERVER, '--scope', 'local'],
        { cwd: checkoutPath, env: { ...process.env, HOME: homeDir } });
    } catch { /* nothing to remove is the normal case */ }
    runCommand('claude', ['mcp', 'add', '--transport', 'http', '--scope', 'local',
      PROJECT_MCP_SERVER, mcpUrl, '--header', `Authorization: Bearer ${token.secret}`],
    { cwd: checkoutPath, env: { ...process.env, HOME: homeDir } });
  } catch (err) {
    // The token exists but nothing records it — take it back rather than
    // leave a credential nobody can find again.
    await revokeProjectToken(servicebay, token.id, doFetch).catch(() => {});
    throw new ProjectError(500,
      `the ServiceBay MCP entry for "${name}" could not be written, so its token was revoked again`,
      String(err?.stderr || err?.message || err).slice(0, 500));
  }

  // Adding un-does a previous Remove: the checkout is a managed project again.
  try { fsImpl.rmSync(noAutostartMarker(devHome, name), { force: true }); } catch { /* nothing to clear */ }

  const startError = startSessionWindow({ devHome, homeDir, tmuxSession, name, runCommand });
  if (startError) warnings.push(`start-claude reported an error: ${startError}`);

  // Do not take start-claude's word for it — ASK tmux. `null` if tmux itself
  // could not be read: an unverified "running: true" is the whole bug class
  // this panel exists to end.
  const started = readSessionState(tmuxSession, name, runTmux);
  const session = started.session;
  if (started.error) {
    warnings.push(`the session could not be confirmed — tmux could not be read: ${started.error}`);
  }
  if (session && !session.running) {
    warnings.push(`no tmux window named "${name}" is running, so this project has no Claude session yet`);
  }

  return {
    ok: true,
    project: {
      name,
      path: checkoutPath,
      cloned,
      token: { id: token.id, scopes: token.scopes },
      mcp: { server: PROJECT_MCP_SERVER, scope: 'local', url: mcpUrl },
      session,
    },
    warnings,
  };
}

/**
 * Remove a project: revoke ITS token, drop ITS MCP entry, stop ITS session.
 * Nothing on disk is deleted, and a checkout this UI did not add is refused
 * outright — `managed` is not advisory, it is the permission.
 */
export async function removeProject(options, servicebay, input) {
  const {
    devHome = '/workspace',
    homeDir = devHome,
    tmuxSession = 'claude',
    fsImpl = fs,
    runTmux = defaultRunTmux,
    runCommand = defaultRunCommand,
    readFile = (p) => fs.readFileSync(p, 'utf-8'),
    doFetch = fetch,
  } = options ?? {};

  const name = String(input?.name ?? '').trim();
  const nameError = validateProjectName(name);
  if (nameError) throw new ProjectError(400, nameError);

  const checkoutPath = path.join(devHome, name);
  // Removing something that is not there FAILS. It does not quietly succeed.
  if (!fsImpl.existsSync(path.join(checkoutPath, '.git'))) {
    throw new ProjectError(404, `there is no checkout named "${name}" under ${devHome}`);
  }

  let tokenId;
  try {
    tokenId = recordedTokenId(homeDir, checkoutPath, readFile);
  } catch (err) {
    // Unknown, not "unmanaged" — refusing on a failed read would be a guess.
    throw new ProjectError(500,
      `could not tell whether "${name}" was added here: ${String(err?.message || err).slice(0, 200)}`);
  }
  if (!tokenId) {
    throw new ProjectError(409,
      `"${name}" was not added through this page — it has no delegated ServiceBay token, so there is nothing here to take back. Leaving it exactly as it is.`);
  }

  const warnings = [];
  // Revoke FIRST: while the entry still names the token, a failure here is
  // retryable. The other order would strand a live credential unrecorded.
  const revoked = await revokeProjectToken(servicebay, tokenId, doFetch);
  if (revoked.alreadyGone) warnings.push(`token ${tokenId} was already revoked on the ServiceBay side`);

  try {
    runCommand('claude', ['mcp', 'remove', PROJECT_MCP_SERVER, '--scope', 'local'],
      { cwd: checkoutPath, env: { ...process.env, HOME: homeDir } });
  } catch (err) {
    throw new ProjectError(500,
      `the token was revoked but the MCP entry for "${name}" could not be removed — the entry now names a dead token`,
      String(err?.stderr || err?.message || err).slice(0, 500));
  }

  // Durable stop: the entrypoint's 300s reconcile honours this marker, so the
  // session does not come back on its own a few minutes from now.
  try {
    fsImpl.mkdirSync(path.dirname(noAutostartMarker(devHome, name)), { recursive: true });
    fsImpl.writeFileSync(noAutostartMarker(devHome, name), `removed from the configuration UI\n`);
  } catch (err) {
    warnings.push(`the container may auto-start this project again — its no-autostart marker could not be written: ${String(err?.message || err).slice(0, 200)}`);
  }

  // Exactly this project's window — see `windowTarget`. No window / no server
  // is the answer "it was not running", not a failure.
  const stopError = stopSessionWindow(tmuxSession, name, runTmux);
  if (stopError) warnings.push(`tmux could not stop the session: ${stopError}`);

  const stopped = readSessionState(tmuxSession, name, runTmux);
  const session = stopped.session;
  if (stopped.error) {
    warnings.push(`the session could not be confirmed stopped — tmux could not be read: ${stopped.error}`);
  }
  if (session?.running) warnings.push(`a tmux window named "${name}" is still running`);

  return {
    ok: true,
    removed: {
      name,
      path: checkoutPath,
      tokenId,
      session,
      // Said out loud so nobody reads Remove as a delete.
      checkoutDeleted: false,
    },
    warnings,
  };
}

/* ───────────────── restart ONE project's session (#2682) ────────────────────
 *
 * A Claude session goes quiet for reasons a restart fixes — a lapsed sign-in
 * that has since been repaired, a wedged MCP connection, an OOM'd process left
 * behind by `remain-on-exit`. Doing it by hand means SSH, tmux, and knowing
 * which window; this is the button.
 *
 * Two failure modes are designed against, because both are silent:
 *
 *   IT MUST NOT TAKE OUT A SIBLING. tmux prefix-matches window names, so the
 *     naive `-t claude:<name>` resolves `solaris` to `solarisbay` on the real
 *     box. Every kill here goes through `windowTarget`, which anchors it with
 *     `=`. The response also reports the sibling windows that are still up, so
 *     "it only restarted mine" is an observation, not a promise.
 *
 *   IT MUST NOT REPORT A SUCCESS THE SESSION DID NOT HAVE. `start-claude` exits
 *     0 in cases where no window ends up running (and its `--continue` fallback
 *     means a window can die milliseconds after it is made), so its exit code
 *     proves nothing. tmux is re-asked afterwards and a missing window is a
 *     hard failure, not a warning. If tmux cannot be read at all the answer is
 *     "unknown" with a 502 — never an optimistic 200.
 *
 * A restart of something that is not there fails loudly: no checkout is a 404,
 * and a checkout the operator REMOVED (its `no-autostart` marker is present) is
 * a 409 rather than a resurrection of a session they deliberately took down.
 */
export function restartProjectSession(options, input) {
  const {
    devHome = '/workspace',
    homeDir = devHome,
    tmuxSession = 'claude',
    fsImpl = fs,
    runTmux = defaultRunTmux,
    runCommand = defaultRunCommand,
  } = options ?? {};

  const name = String(input?.name ?? '').trim();
  const nameError = validateProjectName(name);
  if (nameError) throw new ProjectError(400, nameError);

  const checkoutPath = path.join(devHome, name);
  if (!fsImpl.existsSync(path.join(checkoutPath, '.git'))) {
    throw new ProjectError(404, `there is no checkout named "${name}" under ${devHome}, so there is no session to restart`);
  }
  if (fsImpl.existsSync(noAutostartMarker(devHome, name))) {
    throw new ProjectError(409,
      `"${name}" was removed from this page, so it is marked do-not-auto-start and has no session to restart. `
      + 'Add it again to give it a Claude session.');
  }

  // The window list BEFORE, so the siblings that must survive are recorded
  // rather than assumed. A tmux we cannot read is a stop, not a guess.
  let before;
  try {
    before = readTmuxWindows(tmuxSession, runTmux);
  } catch (err) {
    throw new ProjectError(502,
      `tmux could not be read, so nothing was restarted — the session state for "${name}" is unknown`,
      String(err?.message || err).slice(0, 200));
  }
  const wasRunning = before.includes(name);

  const stopError = stopSessionWindow(tmuxSession, name, runTmux);
  if (stopError) {
    throw new ProjectError(500, `the Claude session for "${name}" could not be stopped, so it was not restarted`, stopError);
  }

  // start-claude skips a checkout that already has a live window, which is
  // exactly why the stop above has to have happened first.
  const startError = startSessionWindow({ devHome, homeDir, tmuxSession, name, runCommand });

  let after;
  try {
    after = readTmuxWindows(tmuxSession, runTmux);
  } catch (err) {
    throw new ProjectError(502,
      `"${name}" was stopped and started again, but tmux could not be read afterwards — `
      + 'whether the session came back is UNKNOWN',
      String(err?.message || err).slice(0, 200));
  }
  if (!after.includes(name)) {
    throw new ProjectError(500,
      `"${name}" has no tmux window after the restart — the session did NOT come back`,
      startError || 'start-claude reported no error, which is why tmux was asked instead');
  }

  const warnings = [];
  if (startError) {
    warnings.push(`start-claude reported an error even though the session is running: ${startError}`);
  }
  if (!wasRunning) {
    warnings.push(`"${name}" had no session before this, so it was STARTED rather than restarted`);
  }
  // The sibling check, reported rather than assumed (acceptance 2).
  const lost = before.filter(w => w !== name && !after.includes(w));
  if (lost.length) {
    warnings.push(`other sessions disappeared during this restart, which should not happen: ${lost.join(', ')}`);
  }

  return {
    ok: true,
    restarted: {
      name,
      path: checkoutPath,
      wasRunning,
      // Measured from `after`, not inferred from the exit code above.
      session: { running: true },
      // The siblings still up, so the panel can say what was left alone.
      others: after.filter(w => w !== name),
    },
    warnings,
  };
}

/* ──────────────────── the GitHub connection (#2681) ─────────────────────────
 *
 * Until now this container's GitHub credential was a hand-made artifact:
 * someone opened a ROOT shell over `podman exec`, ran `gh auth login`, and left
 * behind a `~/.config/gh/hosts.yml` that nothing had declared and nothing could
 * describe. This replaces the CREATION path with the OAuth device flow driven
 * from this page, so connecting needs a browser and no shell at all.
 *
 * The flow is the one `gh auth login --web` performs, spoken directly rather
 * than by driving the CLI: gh's web login is an interactive prompt ("press
 * Enter to open github.com in your browser") that a server can only fake with a
 * pty. Two plain HTTPS calls have no such moving parts —
 *
 *   1. POST /login/device/code → a one-time user code and a verification URL.
 *      The page shows the code; the operator types it into github.com on
 *      whatever device they are holding.
 *   2. POST /login/oauth/access_token, repeatedly → `authorization_pending`
 *      until they finish, then the access token.
 *
 * Four properties this is built around:
 *
 *   THE TOKEN NEVER TOUCHES ARGV, A LOG, OR THE BROWSER. It reaches `gh auth
 *     login --with-token` on STDIN, because /proc/<pid>/cmdline is world-
 *     readable and this container has real LDAP user logins on it. It is never
 *     sent to the page — the page learns the resulting ACCOUNT NAME, nothing
 *     else — and every string that reaches a log or a response first goes
 *     through `redactCredentials`.
 *
 *   THE DEVICE CODE STAYS SERVER-SIDE. The browser gets an opaque flow id; the
 *     `device_code` — the thing that actually redeems the token — lives only in
 *     the map below and is dropped the moment the flow ends or expires.
 *
 *   "CONNECTED" IS EXERCISED, NEVER INFERRED FROM A FILE. Status runs
 *     `gh api user`, an authenticated call to GitHub. A hosts.yml holding an
 *     expired token is NOT connected, and being able to say so is the point:
 *     the presence of a file was exactly what the old hand-made artifact could
 *     prove, and it proved nothing.
 *
 *   THE THREE ANSWERS STAY THREE. `connected` is `true` / `false` / `null`,
 *     never a two-valued flag. gh's exit code 4 is a real NO ("no credential");
 *     a 401 is a real NO with a different reason ("stored, and rejected"); a
 *     missing binary, a timeout, or a DNS failure is `null` — UNKNOWN. Showing
 *     unknown as "not connected" is what gets someone to redo a connection that
 *     already works, or to trust one that does not.
 */

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * The GitHub CLI's own OAuth application. Public by construction — it is
 * compiled into every `gh` binary on every machine — so this is a constant, not
 * a credential, and the token it mints is exactly the one `gh auth login --web`
 * would have made. `CLAUDE_DEV_GITHUB_CLIENT_ID` overrides it for a box that
 * would rather register its own OAuth app.
 */
export const GH_CLI_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a';

/**
 * What the sessions on this box actually do: clone and push (`repo`), resolve
 * org membership the way gh does (`read:org`), gists — and `workflow`, without
 * which a push that touches `.github/workflows` is rejected outright, which is
 * most of what the autoloop pushes.
 */
export const GITHUB_SCOPES = 'repo read:org gist workflow';

/** Credential shapes that must never survive into a log line or a response. */
const CREDENTIAL_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsb_[a-z0-9]{6,}_[A-Za-z0-9]{16,}/g,
];

/** Mask anything token-shaped. Applied to EVERY gh/GitHub message we relay —
 *  those messages are written by someone else and may quote what we sent. */
export function redactCredentials(text) {
  let out = String(text ?? '');
  for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, '<redacted>');
  return out;
}

const firstLine = (text) => String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)[0] ?? '';

/**
 * The environment `gh` runs in.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` are STRIPPED, and that is load-bearing rather
 * than tidy. gh prefers them over hosts.yml, so one left in the process
 * environment would make this page report a connection that has nothing to do
 * with the credential it stores — "connected" while hosts.yml is empty. It also
 * breaks the write half: `gh auth login` REFUSES outright while one is set
 * ("first clear the environment variable"), so Connect would fail on a box that
 * happens to export one for something else.
 */
export function githubEnv({ homeDir, configDir, env = process.env }) {
  const clean = { ...env, HOME: homeDir, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete clean[name];
  return clean;
}

/** Defaults + injection points, resolved once per call. Mirrors `projects`. */
function githubOptions(options = {}) {
  const homeDir = options.homeDir || '/workspace';
  const configDir = options.configDir || path.join(homeDir, '.config', 'gh');
  return {
    homeDir,
    configDir,
    hostsFile: path.join(configDir, 'hosts.yml'),
    hostname: options.hostname || 'github.com',
    clientId: options.clientId || GH_CLI_OAUTH_CLIENT_ID,
    scopes: options.scopes || GITHUB_SCOPES,
    fsImpl: options.fsImpl || fs,
    runCommand: options.runCommand || defaultRunCommand,
    doFetch: options.doFetch || fetch,
    env: options.env || process.env,
    now: options.now || (() => Date.now()),
    // `null` when the platform has no uid to compare against — see
    // `inspectCredential`: no uid means "unknown owner", not "wrong owner".
    uid: options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
  };
}

/**
 * Run one `gh` command and normalise BOTH outcomes into a single shape, so the
 * classifier below is a pure function of `{ exitCode, stdout, stderr,
 * spawnError }` and can be tested without a `gh` binary anywhere.
 *
 * `execFileSync` reports an EXIT code as `err.status` and a spawn/timeout errno
 * as `err.code`; conflating them is how "gh is not installed" ends up rendered
 * as "you are not signed in".
 */
function runGh(runCommand, args, env, timeout, input) {
  try {
    return { exitCode: 0, stdout: String(runCommand('gh', args, { env, timeout, input }) ?? ''), stderr: '', spawnError: '' };
  } catch (err) {
    const exitCode = Number.isInteger(err?.status) ? err.status : null;
    return {
      exitCode,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? ''),
      spawnError: exitCode === null ? String(err?.code || err?.message || err) : '',
    };
  }
}

/** gh's ways of saying "there is no credential here" — a real NO. */
const GH_NO_CREDENTIAL = /to get started with github cli|not logged into any github|no accounts|authentication token not found/i;
/** GitHub's way of saying "there is one, and I reject it" — also a real NO. */
const GH_REJECTED = /bad credentials|http 401|requires authentication/i;

/**
 * `{ connected, account, detail }` from one `gh api user` run.
 *
 * `connected: null` is not a fallback for "something odd" — it is the answer
 * whenever the check itself did not complete, which is a different fact from a
 * completed check that came back negative.
 */
export function classifyGithubStatus(result) {
  if (result.spawnError) {
    return { connected: null, account: '', detail: `the GitHub CLI could not be run: ${redactCredentials(result.spawnError)}` };
  }
  if (result.exitCode === 0) {
    const account = firstLine(result.stdout);
    if (!account) return { connected: null, account: '', detail: 'the GitHub CLI answered without naming an account' };
    return { connected: true, account, detail: '' };
  }
  const said = `${result.stderr}\n${result.stdout}`;
  // 4 is gh's documented "authentication required" exit code; the text match
  // is the belt to its braces, for a version that changes one of the two.
  if (result.exitCode === 4 || GH_NO_CREDENTIAL.test(said)) {
    return { connected: false, account: '', detail: 'no GitHub credential is stored for this container' };
  }
  if (GH_REJECTED.test(said)) {
    return {
      connected: false,
      account: '',
      detail: 'a credential is stored but GitHub rejected it — connect again to replace it',
    };
  }
  return {
    connected: null,
    account: '',
    detail: redactCredentials(firstLine(said)) || `the GitHub CLI exited ${result.exitCode}`,
  };
}

/**
 * What is ACTUALLY on disk at `hosts.yml` — acceptance 3 is about the stored
 * file, so it is measured rather than assumed. Every field is three-valued for
 * the same reason as the rest of this module: a stat that threw EACCES tells us
 * nothing about the mode, and `null` says so.
 */
export function inspectCredential(hostsFile, fsImpl = fs, uid = null) {
  let stat;
  try {
    stat = fsImpl.statSync(hostsFile);
  } catch (err) {
    if (err?.code === 'ENOENT') return { path: hostsFile, exists: false, mode: null, ownedByServer: null, private: null };
    return {
      path: hostsFile,
      exists: null,
      mode: null,
      ownedByServer: null,
      private: null,
      error: redactCredentials(String(err?.message || err)),
    };
  }
  const mode = stat.mode & 0o777;
  return {
    path: hostsFile,
    exists: true,
    mode: `0${mode.toString(8).padStart(3, '0')}`,
    ownedByServer: uid === null ? null : stat.uid === uid,
    private: (mode & 0o077) === 0,
  };
}

/** `GET /api/github`: exercise the credential, and describe the file it is in. */
export function readGithubStatus(options = {}) {
  const o = githubOptions(options);
  const status = classifyGithubStatus(runGh(o.runCommand, ['api', 'user', '--jq', '.login'], githubEnv(o), 20_000));
  return { ...status, hostname: o.hostname, credential: inspectCredential(o.hostsFile, o.fsImpl, o.uid) };
}

/**
 * Re-assert `dev`-only ownership on what gh just wrote, then REPORT what is
 * really there.
 *
 * #2672 hardens these paths on every boot (`secure_dev_private_state` in
 * docker-entrypoint.sh, which chowns before it chmods so a failed chown never
 * strands an unreadable token). A credential created BETWEEN two boots must
 * land inside that guarantee rather than sit world-readable until the next
 * restart — but this process is `dev`, not root, so it can only chmod a file it
 * already owns. On a box still carrying the old root-owned artifact that
 * legitimately fails, and then it must SAY so instead of reporting a mode
 * nobody verified.
 */
function hardenCredential(o) {
  const warnings = [];
  for (const [target, mode] of [[o.configDir, 0o700], [o.hostsFile, 0o600]]) {
    try {
      o.fsImpl.chmodSync(target, mode);
    } catch (err) {
      warnings.push(`could not set mode 0${mode.toString(8)} on ${target}: ${redactCredentials(String(err?.message || err))}`);
    }
  }
  const credential = inspectCredential(o.hostsFile, o.fsImpl, o.uid);
  if (credential.ownedByServer === false) {
    warnings.push(`${credential.path} belongs to another account, so this page could not tighten it.`);
  }
  if (credential.private === false) {
    warnings.push(`${credential.path} is mode ${credential.mode} — other logins on this container can read the token. `
      + 'Restart claude-dev so the boot-time hardening takes ownership of it.');
  }
  if (credential.exists !== true) {
    warnings.push(`${credential.path} could not be inspected after the sign-in, so its owner and mode are unknown.`);
  }
  return { credential, warnings };
}

/**
 * Hand the access token to `gh` on STDIN, wire git to it, tighten the file, and
 * then EXERCISE it. The returned status comes from a fresh `gh api user`, not
 * from the fact that a file was written (acceptance 1).
 *
 * `gh auth setup-git` is not optional: `--with-token` stores the credential but
 * does not register the `credential.https://github.com.helper` entry, so
 * without it `gh` would work and `git push` would still prompt.
 */
export function storeGithubToken(options, token) {
  const o = githubOptions(options);
  try {
    o.fsImpl.mkdirSync(o.configDir, { recursive: true, mode: 0o700 });
  } catch { /* gh creates it itself; a pre-existing dir is the normal case */ }

  const stored = runGh(o.runCommand, ['auth', 'login', '--hostname', o.hostname, '--with-token'],
    githubEnv(o), 30_000, `${token}\n`);
  if (stored.exitCode !== 0) {
    throw new ProjectError(502, 'the GitHub CLI refused to store the credential',
      redactCredentials(firstLine(`${stored.stderr}\n${stored.stdout}`) || stored.spawnError || `gh exited ${stored.exitCode}`));
  }

  const warnings = [];
  const git = runGh(o.runCommand, ['auth', 'setup-git', '--hostname', o.hostname], githubEnv(o), 20_000);
  if (git.exitCode !== 0) {
    warnings.push('the credential is stored for `gh`, but git was not wired to it '
      + `(gh auth setup-git: ${redactCredentials(firstLine(`${git.stderr}\n${git.stdout}`) || git.spawnError || `exited ${git.exitCode}`)}) `
      + '— `git push` may still ask for a password.');
  }

  const hardened = hardenCredential(o);
  warnings.push(...hardened.warnings);

  const status = classifyGithubStatus(runGh(o.runCommand, ['api', 'user', '--jq', '.login'], githubEnv(o), 20_000));
  if (status.connected !== true) {
    warnings.push('the credential was stored but the check against GitHub did not confirm it: '
      + (status.detail || 'no reason was given'));
  }
  return { status: { ...status, hostname: o.hostname, credential: hardened.credential }, warnings };
}

/** Drop flows whose one-time code can no longer be redeemed. */
function pruneDeviceFlows(flows, now) {
  for (const [id, flow] of flows) if (now >= flow.expiresAt) flows.delete(id);
}

async function githubForm(o, url, params, what) {
  let res;
  try {
    res = await o.doFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    throw new ProjectError(502, `GitHub could not be reached to ${what}: ${redactCredentials(String(err?.message || err))}`);
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, ok: res.ok, body, text };
}

/**
 * `POST /api/github/device` — ask GitHub for a one-time code.
 *
 * The browser is handed `flowId`, the USER code and the verification URL. It is
 * never handed `device_code`: that is the half that redeems the token, and it
 * stays in `flows` here.
 */
export async function startGithubDeviceFlow(options, flows) {
  const o = githubOptions(options);
  const res = await githubForm(o, GITHUB_DEVICE_CODE_URL,
    { client_id: o.clientId, scope: o.scopes }, 'start the sign-in');
  if (!res.ok || !res.body?.device_code || !res.body?.user_code) {
    throw new ProjectError(502, 'GitHub refused to start the device sign-in',
      redactCredentials(res.body?.error_description || res.body?.error || res.text.slice(0, 200) || `HTTP ${res.status}`));
  }
  pruneDeviceFlows(flows, o.now());
  const flowId = randomUUID();
  const interval = Math.max(1, Number(res.body.interval) || 5);
  const expiresAt = o.now() + (Number(res.body.expires_in) || 900) * 1000;
  flows.set(flowId, { deviceCode: res.body.device_code, interval, expiresAt });
  return {
    flowId,
    userCode: res.body.user_code,
    verificationUri: res.body.verification_uri || 'https://github.com/login/device',
    interval,
    expiresAt,
    scopes: o.scopes,
  };
}

/**
 * `POST /api/github/device/poll` — one redemption attempt.
 *
 * Every outcome is named: `pending` (nobody has entered the code yet),
 * `expired`, `denied`, `connected`. The device code is spent on the first
 * non-pending answer and dropped from the map either way.
 */
export async function pollGithubDeviceFlow(options, flows, flowId) {
  const o = githubOptions(options);
  const id = String(flowId || '');
  const flow = flows.get(id);
  if (!flow) throw new ProjectError(404, 'that sign-in is not in progress any more — start it again');
  if (o.now() >= flow.expiresAt) {
    flows.delete(id);
    return { state: 'expired', detail: 'the one-time code expired before it was entered on github.com' };
  }

  const res = await githubForm(o, GITHUB_ACCESS_TOKEN_URL, {
    client_id: o.clientId,
    device_code: flow.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, 'finish the sign-in');

  const error = res.body?.error;
  if (error === 'authorization_pending') return { state: 'pending', interval: flow.interval };
  if (error === 'slow_down') {
    // GitHub's own back-off, honoured rather than ignored: keep polling at the
    // old rate and it starts refusing outright.
    flow.interval = Math.max(Number(res.body.interval) || 0, flow.interval + 5);
    return { state: 'pending', interval: flow.interval };
  }
  flows.delete(id);
  if (error === 'expired_token') {
    return { state: 'expired', detail: 'the one-time code expired before it was entered on github.com' };
  }
  if (error === 'access_denied') {
    return { state: 'denied', detail: 'the sign-in was cancelled on github.com' };
  }
  if (error || !res.body?.access_token) {
    throw new ProjectError(502, 'GitHub refused to finish the device sign-in',
      redactCredentials(res.body?.error_description || error || res.text.slice(0, 200) || `HTTP ${res.status}`));
  }
  return { state: 'connected', ...storeGithubToken(options, res.body.access_token) };
}

/* ───────────────── the Claude sign-in repair link (#2682) ───────────────────
 *
 * When the container's Claude sign-in lapses, every session on the box goes
 * quiet at once and the fix is an interactive `claude auth login` inside the
 * container — which used to mean SSH, `podman exec`, and knowing to run it as
 * `dev` with `HOME=/workspace` rather than as root.
 *
 * ServiceBay already ships that repair as a one-tap deep link (e3c261ac): the
 * terminal accepts `?run=<preset key>` and looks the key up in its own
 * `TERMINAL_RUN_PRESETS` whitelist. `run` is a KEY, never a command — that
 * whitelist is the security boundary, and this page neither widens it nor adds
 * a route of its own. All it does is render an `<a href>` at it, because the
 * operator discovering the quiet sessions on this page is one click away from
 * the fix and does not otherwise know the URL exists.
 */

/** The whitelisted preset, and the pod's single container (`<service>-<service>`). */
export const CLAUDE_LOGIN_DEEP_LINK = '/terminal?container=claude-dev-claude-dev&run=claude-login';

/**
 * The BROWSER-facing origin of the ServiceBay app — `https://admin.<domain>`,
 * per `getAdminBaseUrl` in the backend. It is NOT `servicebay.url`: that one is
 * `host.containers.internal:5888`, reachable from inside this container and
 * from nowhere a browser runs.
 *
 * Returns `null` for anything unusable, and the empty-label check is the case
 * that actually happens: a LAN-only box has no public domain, so the template
 * renders `https://admin.` and a link built from it would 404 in the operator's
 * face. `null` travels to the panel as "unknown", which it renders as a reason
 * rather than a broken button.
 */
export function normalizeAppUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.hostname.split('.').some(label => label === '')) return null;
  return url.origin;
}

/** Read a small JSON request body. Anything bigger than 8 KiB is refused. */
function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        reject(new ProjectError(413, 'request body too large'));
        req.destroy();
      }
    });
    req.on('error', (err) => reject(new ProjectError(400, `could not read the request body: ${err.message}`)));
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new ProjectError(400, 'the request body is not valid JSON')); }
    });
  });
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
      servicebay: {
        configured: Boolean(ctx.servicebay.token),
        url: ctx.servicebay.url,
        // Where a BROWSER reaches ServiceBay — `null` when this box has no
        // public domain configured. See `normalizeAppUrl`.
        appUrl: ctx.servicebay.appUrl ?? null,
      },
      // The whitelisted one-tap Claude sign-in repair (#2682), already
      // composed so the panel is a plain `<a href>` and nothing else. `null`
      // when the app origin is unknown — a link we cannot build is not a link
      // we offer.
      claudeSignInUrl: ctx.servicebay.appUrl ? `${ctx.servicebay.appUrl}${CLAUDE_LOGIN_DEEP_LINK}` : null,
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

  /** Add a project (#2680) — clone or adopt, delegate, wire MCP, start it. */
  'POST /api/projects': async (req, res, ctx) => {
    const body = await readJsonRequest(req);
    const result = await addProject(ctx.projectOptions, ctx.servicebay, body);
    ctx.log(`claude-dev config-ui: ${ctx.identity.user} added project "${result.project.name}"`
      + ` (${result.project.cloned ? 'cloned' : 'adopted'}, token ${result.project.token.id})`
      + `${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}`);
    sendJson(res, 201, result);
  },

  /** Remove a project (#2680) — revoke its token, unwire it, stop it. */
  'DELETE /api/projects': async (req, res, ctx) => {
    const result = await removeProject(ctx.projectOptions, ctx.servicebay, { name: ctx.query.get('name') ?? '' });
    ctx.log(`claude-dev config-ui: ${ctx.identity.user} removed project "${result.removed.name}"`
      + ` (token ${result.removed.tokenId} revoked, checkout left on disk)`);
    sendJson(res, 200, result);
  },

  /**
   * Restart ONE project's Claude session (#2682) — stop exactly its window,
   * start it again, then ask tmux whether it really came back.
   */
  'POST /api/projects/restart': async (req, res, ctx) => {
    const body = await readJsonRequest(req);
    const result = restartProjectSession(ctx.projectOptions, body);
    ctx.log(`claude-dev config-ui: ${ctx.identity.user} restarted the session for "${result.restarted.name}"`
      + ` (${result.restarted.wasRunning ? 'was running' : 'was NOT running'};`
      + ` ${result.restarted.others.length} other session(s) left alone)`
      + `${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}`);
    sendJson(res, 200, result);
  },

  /** GitHub connection status (#2681) — measured by an authenticated call. */
  'GET /api/github': (req, res, ctx) => sendJson(res, 200, ctx.github.status()),

  /** Start the device flow (#2681) — returns the code the operator types. */
  'POST /api/github/device': async (req, res, ctx) => {
    const flow = await ctx.github.start();
    // The user code is an authorization artifact with a 15-minute life; it is
    // not logged, and neither is anything else this flow produces.
    ctx.log(`claude-dev config-ui: ${ctx.identity.user} started a GitHub device sign-in (flow ${flow.flowId})`);
    sendJson(res, 201, flow);
  },

  /** One redemption attempt (#2681). The token never comes back out of here. */
  'POST /api/github/device/poll': async (req, res, ctx) => {
    const body = await readJsonRequest(req);
    const result = await ctx.github.poll(body?.flowId ?? '');
    if (result.state === 'connected') {
      ctx.log(`claude-dev config-ui: ${ctx.identity.user} connected GitHub as "${result.status.account}"`
        + ` (${result.status.credential.path} mode ${result.status.credential.mode ?? 'unknown'})`
        + `${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}`);
    }
    sendJson(res, 200, result);
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
  // `appUrl` is the browser-facing ServiceBay origin the sign-in repair link
  // is built on (#2682); `url` stays the container-side API address.
  servicebay = { url: '', token: '', appUrl: null },
  // Options for `collectProjects` (devHome, homeDir, tmuxSession, and the
  // injectable fs/tmux readers the tests drive it with).
  projects = {},
  // Options for the GitHub connection (#2681): homeDir/configDir, the OAuth
  // client id and scopes, and the injectable `runCommand` / `doFetch` / `fsImpl`
  // that let the whole device flow be exercised without a `gh` binary.
  github = {},
  log = console.log,
} = {}) {
  // In-progress device flows, keyed by the opaque id the browser polls with.
  // Per server instance, in memory only: a restart cancels a half-finished
  // sign-in, which is the right outcome for a 15-minute one-time code.
  const githubFlows = new Map();

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
    const ctx = {
      identity: auth.identity,
      servicebay,
      projects: () => collectProjects(projects),
      // The SAME injection point the read path uses (devHome / homeDir /
      // tmuxSession / runTmux / runCommand), so the write path is testable
      // without a real /workspace and there is no second seam to keep in sync.
      projectOptions: projects,
      // Same shape, same reason: one injection point the routes and the tests
      // share, so the device flow has no second seam to keep in sync.
      github: {
        status: () => readGithubStatus(github),
        start: () => startGithubDeviceFlow(github, githubFlows),
        poll: (flowId) => pollGithubDeviceFlow(github, githubFlows, flowId),
      },
      query: url.searchParams,
      log,
    };

    const route = API_ROUTES[`${req.method} ${pathname}`];
    if (route) {
      // Handlers may be async; an unhandled rejection would otherwise leave the
      // request hanging with no answer at all.
      return Promise.resolve()
        .then(() => route(req, res, ctx))
        .catch((err) => {
          const status = Number.isInteger(err?.status) ? err.status : 500;
          log(`claude-dev config-ui: ${req.method} ${pathname} failed — ${err?.message || err}`);
          if (res.headersSent) return res.end();
          sendJson(res, status, { error: String(err?.message || err), ...(err?.detail ? { detail: err.detail } : {}) });
        });
    }
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
      // Set by the pod manifest to `https://admin.{{PUBLIC_DOMAIN}}`, which
      // renders to `https://admin.` on a box with no public domain — hence
      // the validation rather than a bare passthrough (#2682).
      appUrl: normalizeAppUrl(env.SERVICEBAY_APP_URL),
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
    // The GitHub connection (#2681). `gh` is told WHICH config dir to use
    // explicitly rather than left to infer one from HOME/XDG, so the file whose
    // owner and mode this page reports is provably the file gh wrote.
    github: {
      homeDir: env.HOME || env.CLAUDE_DEV_WORKSPACE || '/workspace',
      configDir: env.GH_CONFIG_DIR
        || path.join(env.HOME || env.CLAUDE_DEV_WORKSPACE || '/workspace', '.config', 'gh'),
      clientId: (env.CLAUDE_DEV_GITHUB_CLIENT_ID || '').trim() || GH_CLI_OAUTH_CLIENT_ID,
      scopes: (env.CLAUDE_DEV_GITHUB_SCOPES || '').trim() || GITHUB_SCOPES,
    },
  };
}

export function startFromEnv(env = process.env, log = console.log) {
  const cfg = configFromEnv(env);
  const server = createConfigUiServer({
    requiredGroup: cfg.requiredGroup,
    servicebay: cfg.servicebay,
    projects: cfg.projects,
    github: cfg.github,
    log,
  });
  server.listen(cfg.port, cfg.host, () => {
    log(`claude-dev config-ui: listening on ${cfg.host}:${cfg.port}, `
      + `requiring Authelia identity in group "${cfg.requiredGroup || '(any)'}"; `
      + `ServiceBay API token ${cfg.servicebay.token ? 'present' : 'ABSENT'}; `
      // Said at boot because "the sign-in repair link is missing" is otherwise
      // a mystery with no log line behind it (#2682).
      + `browser-facing ServiceBay origin ${cfg.servicebay.appUrl || 'UNKNOWN (no sign-in repair link)'}.`);
  });
  return server;
}

// Only when executed directly — importing this file (tests) must not listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnv();
}
