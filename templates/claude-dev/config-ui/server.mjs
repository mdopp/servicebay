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
 *     the route table; `'GET /api/projects'` (#2679) and its `POST`/`DELETE`
 *     siblings (#2680) sit next to `'GET /api/session'` and got the auth gate
 *     for free — a handler may be async. Anything that needs
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

/** Run a container-side CLI. Injectable so tests never need a real /workspace. */
function defaultRunCommand(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  if (/[\s -]/.test(url)) return 'a git URL may not contain whitespace or control characters';
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

  try {
    runCommand('start-claude', ['--continue', '--allow-dangerously-skip-permissions', '--', name], {
      cwd: devHome,
      env: { ...process.env, HOME: homeDir, CLAUDE_START_NO_ATTACH: '1', CLAUDE_TMUX_SESSION: tmuxSession },
    });
  } catch (err) {
    warnings.push(`start-claude reported an error: ${String(err?.stderr || err?.message || err).slice(0, 200)}`);
  }

  // Do not take start-claude's word for it — ASK tmux. `null` if tmux itself
  // could not be read: an unverified "running: true" is the whole bug class
  // this panel exists to end.
  let session = null;
  try {
    session = { running: readTmuxWindows(tmuxSession, runTmux).includes(name) };
  } catch (err) {
    warnings.push(`the session could not be confirmed — tmux could not be read: ${String(err?.message || err).slice(0, 200)}`);
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

  try {
    runTmux(['kill-window', '-t', `${tmuxSession}:${name}`]);
  } catch (err) {
    // No window / no server is the answer "it was not running", not a failure.
    const stderr = String(err?.stderr || err?.message || '');
    if (!/no server running|can't find window|window not found|no such window|can't find session|session not found/i.test(stderr)) {
      warnings.push(`tmux could not stop the session: ${stderr.slice(0, 200)}`);
    }
  }

  let session = null;
  try {
    session = { running: readTmuxWindows(tmuxSession, runTmux).includes(name) };
  } catch (err) {
    warnings.push(`the session could not be confirmed stopped — tmux could not be read: ${String(err?.message || err).slice(0, 200)}`);
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
    const ctx = {
      identity: auth.identity,
      servicebay,
      projects: () => collectProjects(projects),
      // The SAME injection point the read path uses (devHome / homeDir /
      // tmuxSession / runTmux / runCommand), so the write path is testable
      // without a real /workspace and there is no second seam to keep in sync.
      projectOptions: projects,
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
