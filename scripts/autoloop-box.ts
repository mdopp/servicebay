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
 * The box address is deployment-specific and secret-adjacent — NEVER hardcoded
 * here. Resolved, in order, from
 *   `$SB_BOX_URL`  full origin, e.g. `https://admin.example.tld` — use this when
 *                  the LAN address is not routable from the agent sandbox (the
 *                  public reverse-proxy origin usually is; #2532),
 *   `$SB_BOX`      "host:port" (assumed plain `http://`), or
 *   the gitignored `build/fcos/install-settings.env` (`STATIC_IP` + `SERVICEBAY_PORT`).
 * The `sb_` token comes from `$SB_TOKEN` or `~/.claude.json`.
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

/** The box's request origin (scheme included). `$SB_BOX_URL` wins so a sandbox
 *  that cannot route the LAN address can point the harness at the public
 *  reverse-proxy origin instead (#2532). */
export function resolveBoxUrl(): string {
  const configured = process.env.SB_BOX_URL ?? process.env.SB_BOX;
  if (configured) return normaliseBoxUrl(configured);
  try {
    const s = parseSettingsEnv(readFileSync('build/fcos/install-settings.env', 'utf8'));
    if (s) return normaliseBoxUrl(`${s.host}:${s.port}`);
  } catch {
    /* fall through */
  }
  throw new Error(
    'box address not found — set $SB_BOX_URL="https://host" (or $SB_BOX="host:port") or provide build/fcos/install-settings.env',
  );
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
  const box = resolveBoxUrl();
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
  const res = await fetch(`${resolveBoxUrl()}/mcp`, {
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
    try {
      const res = await fetch(`${resolveBoxUrl()}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (res.status > 0 && res.status < 500) return true; // 200 or 401 → the app is up
    } catch {
      /* connection refused / timeout → mid-restart, keep trying */
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
