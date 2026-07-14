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
 * The box address is deployment-specific and secret-adjacent — NEVER hardcoded
 * here. Resolved from `$SB_BOX` ("host:port") or the gitignored
 * `build/fcos/install-settings.env` (`STATIC_IP` + `SERVICEBAY_PORT`). The
 * `sb_` token is read from `~/.claude.json`.
 *
 *   tsx scripts/autoloop-box.ts exec "<shell cmd>"    # /mcp exec_command → {code,stdout,stderr}
 *   tsx scripts/autoloop-box.ts channel               # GET /api/system/channel
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

/** The JSON-RPC body for an MCP `tools/call`. */
export function buildMcpBody(tool: string, args: Record<string, unknown>): object {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
}

/** Parse the `/mcp` SSE response of an `exec_command` call into its result.
 *  The stream is `event: message\ndata: {json}`; `result.content[0].text` is a
 *  JSON string `{code,stdout,stderr}`. Returns null if it can't be parsed. */
export function parseMcpExecResult(sse: string): { code: number; stdout: string; stderr: string } | null {
  const dataLine = sse.split('\n').find(l => l.startsWith('data:'));
  if (!dataLine) return null;
  try {
    const env = JSON.parse(dataLine.slice(5).trim()) as { result?: { content?: Array<{ text?: string }> } };
    const text = env.result?.content?.[0]?.text;
    if (typeof text !== 'string') return null;
    const r = JSON.parse(text) as { code?: number; stdout?: string; stderr?: string };
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

export function resolveBox(): string {
  if (process.env.SB_BOX) return process.env.SB_BOX;
  try {
    const s = parseSettingsEnv(readFileSync('build/fcos/install-settings.env', 'utf8'));
    if (s) return `${s.host}:${s.port}`;
  } catch {
    /* fall through */
  }
  throw new Error('box address not found — set $SB_BOX="host:port" or provide build/fcos/install-settings.env');
}

export function getToken(): string {
  const t = extractToken(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  if (!t) throw new Error('no sb_ token found in ~/.claude.json');
  return t;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A raw HTTP call to the box with the Bearer token + a hard timeout. */
export async function api(
  method: string,
  path: string,
  opts: { body?: unknown; origin?: boolean; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  const box = resolveBox();
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.origin) headers['Origin'] = `http://${box}`;
  const res = await fetch(`http://${box}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  return { status: res.status, text: await res.text() };
}

/** Run a shell command on the box via `/mcp` exec_command. */
export async function mcpExec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const box = resolveBox();
  const res = await fetch(`http://${box}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(buildMcpBody('exec_command', { command })),
    signal: AbortSignal.timeout(90000),
  });
  const parsed = parseMcpExecResult(await res.text());
  if (!parsed) throw new Error(`mcpExec: could not parse /mcp response (HTTP ${res.status})`);
  return parsed;
}

/** Current channel, or null if the box didn't answer. */
export async function getChannel(): Promise<string | null> {
  try {
    const { status, text } = await api('GET', '/api/system/channel');
    if (status >= 500 || status === 0) return null;
    return (JSON.parse(text) as { channel?: string }).channel ?? null;
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
      const res = await fetch(`http://${resolveBox()}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (res.status > 0 && res.status < 500) return true; // 200 or 401 → the app is up
    } catch {
      /* connection refused / timeout → mid-restart, keep trying */
    }
    await sleep(backoffMs(attempt));
  }
  return false;
}

/** Read the rotating admin creds from the box's quadlet + POST /api/auth/login
 *  (Origin header required by the CSRF guard) → the `session` cookie. Creds
 *  rotate per install, so we read them fresh each time. */
export async function adminLogin(): Promise<string> {
  const { stdout } = await mcpExec(
    "grep -E 'SERVICEBAY_(USERNAME|PASSWORD)=' ~/.config/containers/systemd/servicebay.container",
  );
  const username = stdout.match(/SERVICEBAY_USERNAME=(\S+)/)?.[1];
  const password = stdout.match(/SERVICEBAY_PASSWORD=(\S+)/)?.[1];
  if (!username || !password) throw new Error('could not read admin creds from the box quadlet');
  const box = resolveBox();
  const res = await fetch(`http://${box}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://${box}` },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15000),
  });
  const cookie = res.headers.get('set-cookie')?.match(/session=[^;]+/)?.[0];
  if (!cookie) throw new Error(`admin login failed (HTTP ${res.status})`);
  return cookie;
}

/** Flip the runtime channel (`dev`|`latest`). Cookie-gated → uses an admin
 *  session. Returns once the POST is accepted (the box restarts async; call
 *  `waitHealth()` after). */
export async function setChannel(target: 'dev' | 'latest', cookie?: string): Promise<void> {
  const session = cookie ?? (await adminLogin());
  const box = resolveBox();
  const res = await fetch(`http://${box}/api/system/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://${box}`, Cookie: session },
    body: JSON.stringify({ channel: target }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status >= 400) throw new Error(`setChannel(${target}) failed: HTTP ${res.status} ${await res.text()}`);
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
      console.error('usage: autoloop-box.ts <exec "cmd"|channel|wait-health [sec]|api METHOD path [jsonBody]>');
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
