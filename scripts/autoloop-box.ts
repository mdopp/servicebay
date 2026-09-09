/**
 * Box-access helper for the autoloop (#2306 slice 2).
 *
 * Deterministic HTTP I/O to the ServiceBay box so stage agents stop hand-rolling
 * it and mis-concluding "box unreachable" — **SSH has no key in this
 * environment; box access is HTTP only** (memory feedback_box_verify_real_
 * consumer_ingress, reference_mcp_servicebay_access). Invariants become
 * structural: a single timeout on every call, backoff retry (a box mid-`:dev`-
 * flip restart is NOT "unreachable"), the `/mcp` Bearer path baked in.
 * Principle: CLAUDE.md "Deterministic execution → scripts; LLMs coordinate +
 * evaluate."
 *
 * **Authorization is the `sb_` MCP token and nothing else (#2532).** Every box
 * call here — including the release-channel flip — carries `Authorization:
 * Bearer <sb_ token>`. This script does NOT, and must NOT, obtain an admin
 * session: it never reads the box's unit/quadlet files, never trades credentials
 * for a session cookie on the login route, and never materialises an admin
 * username/password anywhere in the pipeline (see the guard test). The
 * channel flip goes through the MCP `set_channel` / `get_channel` tools, which
 * the token authorizes at the `lifecycle` / `read` scope. If a step genuinely
 * needs an authenticated *browser* session (the e2e SSO smoke), the operator
 * supplies `SB_USERNAME`/`SB_PASSWORD` in the environment — the pipeline never
 * derives them from the box.
 *
 * The box address is deployment-specific and secret-adjacent — no *deployment*
 * address is hardcoded here. It is resolved as an ORDERED LIST of candidates
 * (#2922), and the first one that actually answers wins:
 *   1. `$SB_BOX_URL`  full origin, e.g. `https://admin.example.tld` — use this
 *                     when the LAN address is not routable from the agent
 *                     sandbox (the public reverse-proxy origin usually is; #2532),
 *      or `$SB_BOX`   "host:port" (assumed plain `http://`),
 *   2. the gitignored `build/fcos/install-settings.env` (`STATIC_IP` + `SERVICEBAY_PORT`),
 *   3. `INTERNAL_BOX_ORIGIN` — the container-to-host app port. This is the one
 *      address that is a *constant*, not a deployment value: an agent container
 *      running ON the box reaches the app only there, because 80/443 are the
 *      reverse proxy and ServiceBay's own vhost is LAN-only `deny all` (assist
 *      `footgun-mcp-from-a-container-on-the-box`, ADR 0007). Without it the
 *      harness inside `claude-dev` could never ask the box anything, and
 *      `--recover` reported `channel-unknown` forever (#2922).
 *
 * Two properties of that resolution are load-bearing and must not be traded away:
 *  - **The token goes only to a candidate that answered.** Each candidate is
 *    probed with an UNAUTHENTICATED `GET /api/health` first (a 401 counts as
 *    "alive" — the route is auth-gated); the `sb_` Bearer is attached only to
 *    the origin that came back. Candidates come from the operator's own env,
 *    the gitignored install settings, or the baked-in constant — never from
 *    box output or any other untrusted input.
 *  - **"No candidate answered" stays its own outcome.** `resolveReachableBoxUrl`
 *    throws `BoxUnreachableError` naming what it tried; it never degrades into
 *    a silent success. Collapsing that into a green result is worse than the
 *    blindness it replaces, because the loop reads exit 0 as "the safety net is up".
 *
 * The `sb_` token comes from `$SB_TOKEN` or `~/.claude.json`. It is never
 * logged, printed or embedded in an error message anywhere in this module.
 *
 *   tsx scripts/autoloop-box.ts exec "<shell cmd>"    # /mcp exec_command → {code,stdout,stderr}
 *   tsx scripts/autoloop-box.ts channel               # /mcp get_channel
 *   tsx scripts/autoloop-box.ts channel-set dev|latest # /mcp set_channel
 *   tsx scripts/autoloop-box.ts wait-health [sec]     # poll until the app answers (bounded)
 *   tsx scripts/autoloop-box.ts api <METHOD> <path> [jsonBody]
 *
 * House pattern: tsx, node: only, global fetch (node 20+), no new runtime dep.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------- pure helpers (unit-tested, no I/O) ----------

/** Parse `STATIC_IP` + `SERVICEBAY_PORT` out of an install-settings.env body. */
export function parseSettingsEnv(text: string): { host: string; port: string } | null {
  const get = (k: string) => text.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'))?.[1];
  const host = get('STATIC_IP');
  const port = get('SERVICEBAY_PORT') ?? '5888';
  return host ? { host, port } : null;
}

/** Extract the `sb_…` token from a `~/.claude.json` blob (or any JSON string). */
export function extractToken(jsonText: string): string | null {
  return jsonText.match(/sb_[A-Za-z0-9_-]{10,}/)?.[0] ?? null;
}

/** Normalise a configured box address into a request origin: a bare
 *  `host:port` becomes `http://host:port`, an explicit `http(s)://…` is kept as
 *  given, and a trailing slash is dropped. Pure — the scheme matters because the
 *  LAN address speaks plain HTTP while the public reverse-proxy origin is HTTPS
 *  (and is often the only one routable from the agent sandbox, #2532). */
export function normaliseBoxUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** A box origin rendered safe to print. A configured address *could* carry
 *  `user:password@` userinfo, and candidate lists end up in log lines and in the
 *  `--recover` reason string — strip the credential rather than trust that
 *  nobody ever sets one. Pure. */
export function redactBoxUrl(url: string): string {
  return url.replace(/:\/\/[^@/]*@/, '://');
}

/**
 * The container-to-host origin of the box's own app port — a **constant**, not
 * a deployment value.
 *
 * `host.containers.internal` is the podman-provided name for the host from
 * inside a container on it (it resolves to the link-local gateway); the app port
 * is where `/mcp` and `/api` live, because ports 80/443 are nginx-proxy-manager
 * and ServiceBay's admin vhost ends in `deny all` (assist
 * `footgun-mcp-from-a-container-on-the-box`). Per ADR 0007 the *name* is used,
 * never a literal IP.
 */
export const INTERNAL_BOX_ORIGIN = 'http://host.containers.internal:5888';

/** Where the candidate list gets its inputs — injectable so the ORDER can be
 *  unit-tested without an env or a real settings file. */
export interface BoxUrlSources {
  env?: Record<string, string | undefined>;
  /** the raw `build/fcos/install-settings.env` body, or null when absent */
  readSettings?: () => string | null;
}

/**
 * The ordered box origins to try, most-specific first.
 *
 * Order is the contract: an explicitly configured address wins (an operator
 * pointing the harness at the public origin must not be silently overridden),
 * then the installed LAN address, then the on-box internal endpoint as the
 * last resort that is always present. De-duplicated, so a configured address
 * that already IS the internal one is tried once.
 */
export function boxUrlCandidates(sources: BoxUrlSources = {}): string[] {
  const env = sources.env ?? process.env;
  const readSettings =
    sources.readSettings ??
    (() => {
      try {
        return readFileSync('build/fcos/install-settings.env', 'utf8');
      } catch {
        return null;
      }
    });

  const out: string[] = [];
  const add = (value: string | undefined | null) => {
    if (!value || !value.trim()) return;
    const url = normaliseBoxUrl(value);
    if (!out.includes(url)) out.push(url);
  };

  add(env.SB_BOX_URL ?? env.SB_BOX);
  const settings = readSettings();
  const parsed = settings ? parseSettingsEnv(settings) : null;
  if (parsed) add(`${parsed.host}:${parsed.port}`);
  add(INTERNAL_BOX_ORIGIN);
  return out;
}

/** No candidate answered. Its own error type so callers can keep "I could not
 *  ask the box at all" distinguishable from every other failure (#2922). */
export class BoxUnreachableError extends Error {
  constructor(public readonly tried: string[]) {
    super(`no box candidate answered — tried ${tried.map(redactBoxUrl).join(', ')}`);
    this.name = 'BoxUnreachableError';
  }
}

/** The JSON-RPC body for an MCP `tools/call`. */
export function buildMcpBody(tool: string, args: Record<string, unknown>): object {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
}

/**
 * Unwrap the `/mcp` SSE response of a `tools/call` into the tool's payload text.
 *
 * The stream is `event: message\ndata: {json-rpc envelope}` (SSE joins multiple
 * `data:` lines of one event with `\n`), and `result.content[0].text` carries the
 * tool's own payload — usually JSON. `isError: true` is a *handled* refusal
 * (scope denied, mutations disabled, …) whose text is the human-readable reason,
 * so it is surfaced as an error rather than collapsed into "unparseable": a
 * caller that cannot tell "the box refused the flip" from "the box didn't answer"
 * cannot report a trustworthy verdict. Pure — exported for unit tests.
 */
export function parseMcpToolResult(sse: string): { ok: true; text: string } | { ok: false; error: string } {
  const data = sse
    .split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trim())
    .join('\n');
  if (!data) return { ok: false, error: 'no SSE data line in the /mcp response' };
  let env: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  try {
    env = JSON.parse(data) as typeof env;
  } catch {
    return { ok: false, error: 'unparseable /mcp response envelope' };
  }
  if (env.error) return { ok: false, error: env.error.message ?? 'JSON-RPC error' };
  const text = env.result?.content?.[0]?.text;
  if (typeof text !== 'string') return { ok: false, error: 'no text content in the tool result' };
  if (env.result?.isError) return { ok: false, error: text };
  return { ok: true, text };
}

/** Parse the `/mcp` SSE response of an `exec_command` call into its result.
 *  `result.content[0].text` is a JSON string `{code,stdout,stderr}`. Returns
 *  null if it can't be parsed. */
export function parseMcpExecResult(sse: string): { code: number; stdout: string; stderr: string } | null {
  const parsed = parseMcpToolResult(sse);
  if (!parsed.ok) return null;
  try {
    const r = JSON.parse(parsed.text) as { code?: number; stdout?: string; stderr?: string };
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return null;
  }
}

/** Capped exponential backoff (ms) for retrying a mid-restart box. */
export function backoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 15000);
}

// ---------- effectful (I/O) ----------

/** Does this origin answer as the ServiceBay app? Unauthenticated on purpose —
 *  the probe decides where the token may go, so it must not carry it. `/api/health`
 *  is auth-gated, so a 401 is proof the app answered; anything below 500 counts. */
async function boxOriginAnswers(origin: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

let cachedBoxOrigin: string | null = null;

/** Drop the resolved-origin memo (tests; a long-lived process that moved boxes). */
export function resetBoxUrlCache(): void {
  cachedBoxOrigin = null;
}

/**
 * The box's request origin: the first candidate that actually answers.
 *
 * Falling THROUGH is the point (#2922) — a configured address that no longer
 * routes (or never did, from inside a container on the box) must not end the
 * search. Memoised per process so the probe costs one extra request per run.
 * Throws `BoxUnreachableError` when nothing answers — that case must stay loud
 * and distinguishable, never a quiet fallback to some address.
 */
export async function resolveReachableBoxUrl(opts: { timeoutMs?: number } = {}): Promise<string> {
  if (cachedBoxOrigin) return cachedBoxOrigin;
  const candidates = boxUrlCandidates();
  for (const candidate of candidates) {
    if (await boxOriginAnswers(candidate, opts.timeoutMs ?? 8000)) {
      cachedBoxOrigin = candidate;
      return candidate;
    }
  }
  throw new BoxUnreachableError(candidates);
}

/** The candidate list as safe-to-print strings — for the "I could not ask the
 *  box" reason, which has to name what it tried. */
export function describeBoxCandidates(): string[] {
  return boxUrlCandidates().map(redactBoxUrl);
}

/** The `sb_` MCP token: `$SB_TOKEN` (operator-supplied) or `~/.claude.json`.
 *  This is the ONLY credential the harness uses — see the module header. */
export function getToken(): string {
  if (process.env.SB_TOKEN) return process.env.SB_TOKEN;
  const t = extractToken(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  if (!t) throw new Error('no sb_ token found in $SB_TOKEN or ~/.claude.json');
  return t;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A raw HTTP call to the box with the Bearer token + a hard timeout. */
export async function api(
  method: string,
  path: string,
  opts: { body?: unknown; origin?: boolean; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  const box = await resolveReachableBoxUrl();
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.origin) headers['Origin'] = box;
  const res = await fetch(`${box}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  return { status: res.status, text: await res.text() };
}

/** POST one `tools/call` to `/mcp` with the Bearer token; returns the raw body. */
async function mcpFetch(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${await resolveReachableBoxUrl()}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(buildMcpBody(tool, args)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

/** Call an MCP tool whose payload is JSON, authorized by the `sb_` token.
 *  Throws with the box's own reason on a refusal (scope / mutations disabled). */
export async function mcpCall<T>(tool: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  const { status, body } = await mcpFetch(tool, args, timeoutMs);
  const parsed = parseMcpToolResult(body);
  if (!parsed.ok) throw new Error(`mcp ${tool} failed (HTTP ${status}): ${parsed.error}`);
  try {
    return JSON.parse(parsed.text) as T;
  } catch {
    throw new Error(`mcp ${tool}: payload was not JSON: ${parsed.text.slice(0, 200)}`);
  }
}

/** Run a shell command on the box via `/mcp` exec_command. */
export async function mcpExec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { status, body } = await mcpFetch('exec_command', { command }, 90000);
  const parsed = parseMcpExecResult(body);
  if (!parsed) throw new Error(`mcpExec: could not parse /mcp response (HTTP ${status})`);
  return parsed;
}

/** Current channel via the MCP `get_channel` tool (token-authorized, `read`
 *  scope), or null if the box didn't answer. `null` must stay reserved for "no
 *  answer" — `confirmFlipBack` treats it as "not yet", never as a verdict. */
export async function getChannel(): Promise<string | null> {
  try {
    const r = await mcpCall<{ channel?: string }>('get_channel', {}, 15000);
    return r.channel ?? null;
  } catch {
    return null;
  }
}

/** Poll until the app answers (a 401 counts as UP — it's auth-gated but alive).
 *  A box mid-`:dev`-flip restart returns nothing for a bit; that's NOT
 *  unreachable — retry with backoff up to `timeoutSec`. Returns true if up. */
export async function waitHealth(timeoutSec = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    // Re-resolve every pass: a box mid-flip can come back on a different
    // candidate than the one that answered before, and the probe IS the health
    // check — a 401 means the app is up.
    resetBoxUrlCache();
    for (const candidate of boxUrlCandidates()) {
      if (await boxOriginAnswers(candidate, 8000)) {
        cachedBoxOrigin = candidate;
        return true;
      }
    }
    await sleep(backoffMs(attempt));
  }
  return false;
}

/**
 * Flip the runtime channel (`dev`|`latest`) through the MCP `set_channel` tool.
 *
 * Authorized by the `sb_` token's `lifecycle` scope — **no admin session, no
 * credential read** (#2532). The old shape scraped the box's unit file for the
 * rotating admin username/password and traded them for a session cookie purely
 * to authorize this one call; that materialised an admin password inside the
 * pipeline on every verify run, and it is gone. `set_channel` is a mutating,
 * non-destroy-tier tool, so it needs no approval round-trip.
 *
 * Two properties this buys the never-stranded guarantee (`confirmFlipBack`):
 *  - **Symmetric authority.** The flip *to* `:dev` and the flip *back* to
 *    `:latest` are the same call with the same static token. If the box would
 *    refuse the flip-back it refuses the flip out, so the run never reaches a
 *    state it cannot leave. The old admin session could be obtained before the
 *    flip and be unobtainable after it (a restarting box, rotated creds).
 *  - **No dependency on the box's own state.** Nothing has to be read off the
 *    box first, so the flip-back needs no successful prior read to be issuable.
 *
 * Returns once the call is accepted (pull + restart run in the background; call
 * `waitHealth()` / poll `getChannel()` after).
 */
export async function setChannel(target: 'dev' | 'latest'): Promise<void> {
  const r = await mcpCall<{ ok?: boolean; channel?: string }>('set_channel', { channel: target }, 30000);
  if (r.ok !== true) throw new Error(`setChannel(${target}) not accepted: ${JSON.stringify(r)}`);
}

// ---------- CLI ----------

async function cli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'exec':
      console.log(JSON.stringify(await mcpExec(rest.join(' '))));
      break;
    case 'channel':
      console.log(JSON.stringify({ channel: await getChannel() }));
      break;
    case 'channel-set': {
      const target = rest[0];
      if (target !== 'dev' && target !== 'latest') {
        console.error('channel-set expects dev|latest');
        process.exit(2);
      }
      await setChannel(target);
      console.log(JSON.stringify({ set: target }));
      break;
    }
    case 'wait-health': {
      const ok = await waitHealth(rest[0] ? Number(rest[0]) : 300);
      console.log(JSON.stringify({ up: ok }));
      if (!ok) process.exit(1); // ok → fall through to break (natural exit 0)
      break;
    }
    case 'api': {
      const [method, path, body] = rest;
      const r = await api(method ?? 'GET', path ?? '/', { body: body ? JSON.parse(body) : undefined, origin: true });
      console.log(JSON.stringify(r));
      break;
    }
    default:
      console.error(
        'usage: autoloop-box.ts <exec "cmd"|channel|channel-set dev|latest|wait-health [sec]|api METHOD path [jsonBody]>',
      );
      process.exit(2);
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('autoloop-box.ts') || invoked.endsWith('autoloop-box.js')) {
  cli().catch(e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
