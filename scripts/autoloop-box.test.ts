import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSettingsEnv,
  extractToken,
  buildMcpBody,
  parseMcpExecResult,
  parseMcpToolResult,
  normaliseBoxUrl,
  redactBoxUrl,
  backoffMs,
  setChannel,
  getChannel,
  boxUrlCandidates,
  describeBoxCandidates,
  resolveReachableBoxUrl,
  resetBoxUrlCache,
  readChannel,
  channelCommand,
  channelExitCode,
  channelResultLine,
  classifyChannelFailure,
  mcpFailureKind,
  BoxUnreachableError,
  McpCallError,
  INTERNAL_BOX_ORIGIN,
} from './autoloop-box';

describe('parseSettingsEnv', () => {
  it('pulls STATIC_IP + SERVICEBAY_PORT', () => {
    expect(parseSettingsEnv('HOST_USER=core\nSTATIC_IP=10.0.0.5\nSERVICEBAY_PORT=5888\n')).toEqual({ host: '10.0.0.5', port: '5888' });
  });
  it('defaults the port to 5888 when absent', () => {
    expect(parseSettingsEnv('STATIC_IP=10.0.0.5\n')).toEqual({ host: '10.0.0.5', port: '5888' });
  });
  it('tolerates quotes and trailing comments', () => {
    expect(parseSettingsEnv('STATIC_IP="10.0.0.5"  # lan\nSERVICEBAY_PORT=6000')).toEqual({ host: '10.0.0.5', port: '6000' });
  });
  it('returns null without a host', () => {
    expect(parseSettingsEnv('SERVICEBAY_PORT=5888')).toBeNull();
  });
});

describe('extractToken', () => {
  it('finds an sb_ token in a json blob', () => {
    expect(extractToken('{"mcpServers":{"servicebay":{"headers":{"Authorization":"Bearer sb_abc123DEF_ghij"}}}}')).toBe('sb_abc123DEF_ghij');
  });
  it('returns null when none present', () => {
    expect(extractToken('{"x":1}')).toBeNull();
  });
});

describe('buildMcpBody', () => {
  it('builds a tools/call JSON-RPC body', () => {
    expect(buildMcpBody('exec_command', { command: 'ls' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exec_command', arguments: { command: 'ls' } },
    });
  });
});

describe('parseMcpExecResult', () => {
  it('parses the SSE data line → {code,stdout,stderr}', () => {
    const sse = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\"code\\":0,\\"stdout\\":\\"ok\\",\\"stderr\\":\\"\\"}"}]}}\n';
    expect(parseMcpExecResult(sse)).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });
  it('defaults missing fields', () => {
    const sse = 'data: {"result":{"content":[{"text":"{\\"stdout\\":\\"hi\\"}"}]}}';
    expect(parseMcpExecResult(sse)).toEqual({ code: 0, stdout: 'hi', stderr: '' });
  });
  it('returns null on a malformed / non-data payload', () => {
    expect(parseMcpExecResult('event: message\n(no data)')).toBeNull();
    expect(parseMcpExecResult('data: not json')).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps at 15s', () => {
    expect(backoffMs(0)).toBe(2000);
    expect(backoffMs(1)).toBe(4000);
    expect(backoffMs(2)).toBe(8000);
    expect(backoffMs(10)).toBe(15000); // capped
  });
});

describe('normaliseBoxUrl', () => {
  it('assumes plain http for a bare host:port (the LAN address)', () => {
    expect(normaliseBoxUrl('10.0.0.5:5888')).toBe('http://10.0.0.5:5888');
  });
  it('keeps an explicit scheme — the public reverse-proxy origin is https (#2532)', () => {
    expect(normaliseBoxUrl('https://admin.example.tld')).toBe('https://admin.example.tld');
  });
  it('drops a trailing slash so paths concatenate cleanly', () => {
    expect(normaliseBoxUrl(' https://admin.example.tld/ ')).toBe('https://admin.example.tld');
  });
});

describe('parseMcpToolResult', () => {
  it('unwraps the tool payload text', () => {
    const sse = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\"channel\\":\\"dev\\"}"}]}}\n';
    expect(parseMcpToolResult(sse)).toEqual({ ok: true, text: '{"channel":"dev"}' });
  });
  it('surfaces an isError refusal as an error with the box\'s own reason', () => {
    const sse = 'data: {"result":{"content":[{"text":"Token scope \'lifecycle\' required for set_channel"}],"isError":true}}';
    expect(parseMcpToolResult(sse)).toEqual({
      ok: false,
      error: "Token scope 'lifecycle' required for set_channel",
    });
  });
  it('surfaces a JSON-RPC transport error', () => {
    expect(parseMcpToolResult('data: {"error":{"message":"unauthorized"}}')).toEqual({ ok: false, error: 'unauthorized' });
  });
  it('reports a missing / unparseable envelope rather than throwing', () => {
    expect(parseMcpToolResult('event: message\n(no data)').ok).toBe(false);
    expect(parseMcpToolResult('data: not json').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Channel flip over the MCP token (#2532) — the security-load-bearing tests.
// ---------------------------------------------------------------------------

const sseOf = (payload: unknown, isError = false) =>
  `event: message\ndata: ${JSON.stringify({
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) },
  })}\n\n`;

interface Captured {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Stub the box. `/api/health` is answered by the reachability probe (a 401 is
 *  "alive"), everything else goes to `reply`. `health` lets a test make a given
 *  origin refuse the probe — 0 means "connection refused". */
function stubBox(
  reply: (call: Captured) => { body: string; status?: number } | Promise<never>,
  opts: { health?: (url: string) => number } = {},
): Captured[] {
  const calls: Captured[] = [];
  vi.stubEnv('SB_BOX_URL', 'https://box.example.tld');
  vi.stubEnv('SB_TOKEN', 'sb_test_token_value_0123');
  vi.stubGlobal('fetch', async (url: string, init: Captured['init'] = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (call.url.endsWith('/api/health')) {
      const status = opts.health ? opts.health(call.url) : 401;
      if (status === 0) throw new Error('ECONNREFUSED');
      return { status, text: async () => '' } as unknown as Response;
    }
    const res = await reply(call);
    return { status: res.status ?? 200, text: async () => res.body } as unknown as Response;
  });
  return calls;
}

/** Only the calls that carry the token — the probe deliberately does not. */
const mcpCalls = (calls: Captured[]) => calls.filter(c => c.url.endsWith('/mcp'));

beforeEach(() => {
  resetBoxUrlCache();
});

afterEach(() => {
  resetBoxUrlCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('setChannel', () => {
  it('flips via the MCP set_channel tool with the Bearer token — never an admin login', async () => {
    const calls = stubBox(() => ({ body: sseOf({ ok: true, channel: 'dev' }) }));
    await setChannel('dev');
    expect(mcpCalls(calls)).toHaveLength(1);
    const [call] = mcpCalls(calls) as [Captured];
    expect(call.url).toBe('https://box.example.tld/mcp');
    expect(call.init.headers?.Authorization).toBe('Bearer sb_test_token_value_0123');
    expect(JSON.parse(call.init.body as string)).toMatchObject({
      method: 'tools/call',
      params: { name: 'set_channel', arguments: { channel: 'dev' } },
    });
    // The whole point of #2532: no credential-bearing request anywhere.
    expect(calls.some(c => c.url.includes('/api/auth/login'))).toBe(false);
    expect(calls.some(c => (c.init.body ?? '').includes('exec_command'))).toBe(false);
  });

  it('flips back to :latest through the same call — symmetric authority', async () => {
    const calls = stubBox(() => ({ body: sseOf({ ok: true, channel: 'latest' }) }));
    await setChannel('latest');
    expect(JSON.parse((mcpCalls(calls)[0] as Captured).init.body as string)).toMatchObject({
      params: { name: 'set_channel', arguments: { channel: 'latest' } },
    });
  });

  it('throws with the box\'s reason when the token is refused (mutations off / scope)', async () => {
    stubBox(() => ({ body: sseOf('MCP mutations are disabled', true) }));
    await expect(setChannel('latest')).rejects.toThrow(/mutations are disabled/);
  });

  it('throws when the tool answers without ok:true', async () => {
    stubBox(() => ({ body: sseOf({ channel: 'latest' }) }));
    await expect(setChannel('latest')).rejects.toThrow(/not accepted/);
  });
});

describe('getChannel', () => {
  it('reads the channel via the MCP get_channel tool', async () => {
    const calls = stubBox(() => ({ body: sseOf({ channel: 'dev' }) }));
    await expect(getChannel()).resolves.toBe('dev');
    expect(JSON.parse((mcpCalls(calls)[0] as Captured).init.body as string)).toMatchObject({
      params: { name: 'get_channel', arguments: {} },
    });
  });

  it('returns null when the box does not answer — "not yet", never a verdict', async () => {
    stubBox(() => Promise.reject(new Error('ECONNREFUSED')) as Promise<never>);
    await expect(getChannel()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Box-URL resolution as an ORDERED CANDIDATE LIST (#2922). The harness runs in
// a container ON the box, where the configured/installed LAN address does not
// route — but "nothing answered" must never be laundered into a success.
// ---------------------------------------------------------------------------

describe('boxUrlCandidates — the resolution ORDER', () => {
  const noSettings = () => null;

  it('tries the env-configured address FIRST, then the installed address, then the on-box endpoint', () => {
    expect(
      boxUrlCandidates({
        env: { SB_BOX_URL: 'https://admin.example.tld' },
        readSettings: () => 'STATIC_IP=10.0.0.5\nSERVICEBAY_PORT=5888\n',
      }),
    ).toEqual(['https://admin.example.tld', 'http://10.0.0.5:5888', INTERNAL_BOX_ORIGIN]);
  });

  it('accepts $SB_BOX as the configured address, and $SB_BOX_URL wins over it', () => {
    expect(boxUrlCandidates({ env: { SB_BOX: '10.0.0.5:5888' }, readSettings: noSettings })).toEqual([
      'http://10.0.0.5:5888',
      INTERNAL_BOX_ORIGIN,
    ]);
    expect(
      boxUrlCandidates({ env: { SB_BOX_URL: 'https://admin.example.tld', SB_BOX: '10.0.0.5:5888' }, readSettings: noSettings })[0],
    ).toBe('https://admin.example.tld');
  });

  it('ALWAYS ends with the on-box endpoint — with nothing configured that is the whole list (the #2922 environment)', () => {
    expect(boxUrlCandidates({ env: {}, readSettings: noSettings })).toEqual([INTERNAL_BOX_ORIGIN]);
  });

  it('does not repeat a candidate that is already the on-box endpoint', () => {
    expect(boxUrlCandidates({ env: { SB_BOX_URL: INTERNAL_BOX_ORIGIN }, readSettings: noSettings })).toEqual([
      INTERNAL_BOX_ORIGIN,
    ]);
  });
});

/** Only the on-box endpoint answers; every other candidate refuses. */
const onlyInternalAnswers = (url: string) => (url.startsWith(INTERNAL_BOX_ORIGIN) ? 401 : 0);

describe('resolveReachableBoxUrl — falls THROUGH to the candidate that answers', () => {
  it('the case that matters: a CONFIGURED address that does not answer, with the on-box endpoint answering', async () => {
    const calls = stubBox(() => ({ body: sseOf({ channel: 'latest' }) }), { health: onlyInternalAnswers });
    await expect(resolveReachableBoxUrl()).resolves.toBe(INTERNAL_BOX_ORIGIN);
    // The configured address was still tried FIRST, the on-box endpoint LAST —
    // order is the contract, not just "something answered".
    const probed = calls.map(c => c.url);
    expect(probed[0]).toBe('https://box.example.tld/api/health');
    expect(probed.at(-1)).toBe(`${INTERNAL_BOX_ORIGIN}/api/health`);
  });

  it('stops at the first candidate that answers — a 401 is "alive", the route is auth-gated', async () => {
    const calls = stubBox(() => ({ body: '' }));
    await expect(resolveReachableBoxUrl()).resolves.toBe('https://box.example.tld');
    expect(calls.map(c => c.url)).toEqual(['https://box.example.tld/api/health']);
  });

  it('a 5xx is NOT an answer — it falls through like a refused connection', async () => {
    stubBox(() => ({ body: '' }), { health: url => (url.startsWith(INTERNAL_BOX_ORIGIN) ? 401 : 502) });
    await expect(resolveReachableBoxUrl()).resolves.toBe(INTERNAL_BOX_ORIGIN);
  });

  it('THROWS BoxUnreachableError naming the candidates when none answers — never a silent success', async () => {
    stubBox(() => ({ body: '' }), { health: () => 0 });
    const err = await resolveReachableBoxUrl().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoxUnreachableError);
    const { tried, message } = err as BoxUnreachableError;
    expect(tried[0]).toBe('https://box.example.tld');
    expect(tried.at(-1)).toBe(INTERNAL_BOX_ORIGIN);
    expect(message).toContain('https://box.example.tld');
    expect(message).toContain(INTERNAL_BOX_ORIGIN);
  });

  it('getChannel stays null — "could not ask" is not "on :latest"', async () => {
    stubBox(() => ({ body: '' }), { health: () => 0 });
    await expect(getChannel()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token handling for the new destination (#2922, security).
// ---------------------------------------------------------------------------

describe('the sb_ token goes ONLY to a candidate resolved by the ordered list', () => {
  it('the reachability probe carries no Authorization header at all', async () => {
    const calls = stubBox(() => ({ body: sseOf({ channel: 'latest' }) }), { health: onlyInternalAnswers });
    await expect(getChannel()).resolves.toBe('latest');
    const probes = calls.filter(c => c.url.endsWith('/api/health'));
    expect(probes.length).toBeGreaterThanOrEqual(2); // the dead configured one, then the live on-box one
    for (const probe of probes) expect(probe.init.headers?.Authorization).toBeUndefined();
  });

  it('sends the Bearer to the candidate that answered, and to no other origin', async () => {
    const calls = stubBox(() => ({ body: sseOf({ channel: 'latest' }) }), { health: onlyInternalAnswers });
    await getChannel();
    const authed = calls.filter(c => c.init.headers?.Authorization !== undefined);
    expect(authed.map(c => c.url)).toEqual([`${INTERNAL_BOX_ORIGIN}/mcp`]);
  });

  it('the added on-box candidate is a fixed constant, not a value read from anywhere', () => {
    // Not env-derived, not box-derived, not user input: a literal in the module.
    expect(INTERNAL_BOX_ORIGIN).toBe('http://host.containers.internal:5888');
    expect(readFileSync('scripts/autoloop-box.ts', 'utf8')).toContain(
      "export const INTERNAL_BOX_ORIGIN = 'http://host.containers.internal:5888';",
    );
    // ADR 0007: the NAME, never a literal LAN/link-local IP.
    expect(INTERNAL_BOX_ORIGIN).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('redacts userinfo out of any candidate that gets printed', () => {
    expect(redactBoxUrl('https://admin:hunter2@box.example.tld')).toBe('https://box.example.tld');
    expect(redactBoxUrl('http://host.containers.internal:5888')).toBe('http://host.containers.internal:5888');
    vi.stubEnv('SB_BOX_URL', 'https://admin:hunter2@box.example.tld');
    const described = describeBoxCandidates();
    expect(described[0]).toBe('https://box.example.tld');
    expect(described.at(-1)).toBe(INTERNAL_BOX_ORIGIN);
    expect(described.join(' ')).not.toContain('hunter2');
  });

  it('no code path in the box helper or the verify harness prints the token', () => {
    for (const file of ['scripts/autoloop-box.ts', 'scripts/autoloop-dev-verify.ts']) {
      const src = readFileSync(file, 'utf8');
      const printing = src
        .split('\n')
        .filter(l => /console\.(log|error|warn|info)/.test(l))
        .filter(l => /getToken|SB_TOKEN|Bearer|\bsb_/i.test(l));
      expect(printing, `${file} must never print the token`).toEqual([]);
      // …and it is never interpolated into an Error message either.
      expect(/throw new Error\([^)]*getToken\(\)/.test(src)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural guard (#2532): the pipeline must not re-grow a path that derives
// admin credentials from the box. Prose said "don't"; this makes it fail CI.
// ---------------------------------------------------------------------------

describe('no credential-derivation path in the box-verify pipeline', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['reads the admin creds out of the box quadlet', /servicebay\.container/],
    ['names the rotating admin env vars', /SERVICEBAY_(USERNAME|PASSWORD)/],
    ['POSTs an admin login', /api\/auth\/login/],
  ];

  const scriptSources = readdirSync('scripts')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => [join('scripts', f), readFileSync(join('scripts', f), 'utf8')] as const);

  it.each(FORBIDDEN)('no script %s', (_what, pattern) => {
    expect(scriptSources.filter(([, src]) => pattern.test(src)).map(([f]) => f)).toEqual([]);
  });

  const playbook = '.claude/skills/autoloop-issues/stages/box-verify.md';

  it.each(FORBIDDEN)('the box-verify playbook never %s', (_what, pattern) => {
    expect(pattern.test(readFileSync(playbook, 'utf8'))).toBe(false);
  });

  it('the box-verify playbook names the sanctioned MCP channel tools instead', () => {
    const md = readFileSync(playbook, 'utf8');
    expect(md).toMatch(/set_channel/);
    expect(md).toMatch(/get_channel/);
  });
});

// ---------------------------------------------------------------------------
// The `channel` CLI cannot report failure — #2940. It was the box-verify
// stage's reachability probe and it exited 0 with `{"channel":null}` for an
// unreachable box, a rejected token, a timeout and an unreadable reply alike.
// The stage reads that as "I have a path and the box is not on :dev", skips the
// flip-back, and the box stays stranded on `:dev` (the #2826 failure mode,
// reached through the probe meant to prevent it). So the gate is the CLASS of
// failures, not one of them.
// ---------------------------------------------------------------------------

describe('mcpFailureKind — one place decides what an unreadable reply was', () => {
  it('a rejected credential is unauthorized, whatever the body looked like', () => {
    expect(mcpFailureKind(401, 'no SSE data line in the /mcp response')).toBe('unauthorized');
    expect(mcpFailureKind(403, 'unparseable /mcp response envelope')).toBe('unauthorized');
  });
  it("the box's own refusal text is a refusal, not a malformed reply", () => {
    expect(mcpFailureKind(200, "Token scope 'lifecycle' required for set_channel")).toBe('refused');
  });
  it('the envelope diagnostics are malformed', () => {
    expect(mcpFailureKind(200, 'no SSE data line in the /mcp response')).toBe('malformed');
    expect(mcpFailureKind(200, 'unparseable /mcp response envelope')).toBe('malformed');
    expect(mcpFailureKind(200, 'no text content in the tool result')).toBe('malformed');
  });
});

describe('classifyChannelFailure — every way the read fails keeps its own name', () => {
  it('an unreachable box names the candidates it tried', () => {
    const c = classifyChannelFailure(new BoxUnreachableError(['https://admin:hunter2@box.example.tld', INTERNAL_BOX_ORIGIN]));
    expect(c.reason).toBe('unreachable');
    expect(c.tried).toEqual(['https://box.example.tld', INTERNAL_BOX_ORIGIN]);
    expect(c.tried?.join(' ')).not.toContain('hunter2'); // userinfo is stripped before it is printed
  });
  it('an McpCallError keeps the kind the call site already knew', () => {
    expect(classifyChannelFailure(new McpCallError('mcp get_channel failed (HTTP 401): x', 401, 'unauthorized')).reason).toBe('unauthorized');
    expect(classifyChannelFailure(new McpCallError('mcp get_channel: payload was not JSON: <html>', 200, 'malformed')).reason).toBe('malformed');
  });
  it('the client-side deadline is a timeout, not a verdict about the box', () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    expect(classifyChannelFailure(e).reason).toBe('timeout');
  });
  it('anything else is still named, never swallowed', () => {
    expect(classifyChannelFailure(new Error('ECONNRESET')).reason).toBe('unknown');
  });
});

/** Drive the REAL `channel` command and capture what it printed + returned. */
async function runChannelCommand(): Promise<{ code: number; line: string; warned: string[] }> {
  const printed: string[] = [];
  const warned: string[] = [];
  const code = await channelCommand(
    l => printed.push(l),
    l => warned.push(l),
  );
  return { code, line: printed.join('\n'), warned };
}

describe('the channel CLI distinguishes latest / dev / could-not-read (#2940)', () => {
  it('exits 0 and reports the channel when the box answers latest', async () => {
    stubBox(() => ({ body: sseOf({ channel: 'latest' }) }));
    const { code, line } = await runChannelCommand();
    expect(code).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ channel: 'latest', ok: true });
  });

  it('exits 0 and reports :dev — a different answer, not a different outcome', async () => {
    stubBox(() => ({ body: sseOf({ channel: 'dev' }) }));
    const { code, line } = await runChannelCommand();
    expect(code).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ channel: 'dev', ok: true });
  });

  // The class: EVERY way the read can fail must be non-zero. A single
  // unreachable-box case is not the gate (#2940).
  const FAILURE_MODES: Array<[ChannelReadFailureCase, () => void, string]> = [
    [
      'unreachable',
      () => stubBox(() => ({ body: '' }), { health: () => 0 }),
      'no box candidate answered',
    ],
    ['unauthorized', () => stubBox(() => ({ body: '', status: 401 })), 'HTTP 401'],
    [
      'timeout',
      () =>
        stubBox(() => {
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          return Promise.reject(e) as Promise<never>;
        }),
      'timeout',
    ],
    ['malformed', () => stubBox(() => ({ body: 'event: message\ndata: not json' })), 'unparseable'],
  ];

  it.each(FAILURE_MODES)('exits non-zero on a %s read, naming the reason', async (reason, arrange, detailNeedle) => {
    arrange();
    const { code, line, warned } = await runChannelCommand();
    expect(code).not.toBe(0);
    const parsed = JSON.parse(line) as { channel: unknown; ok: boolean; reason: string; detail: string };
    expect(parsed.channel).toBeNull(); // never laundered into "not on dev"
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe(reason);
    expect(parsed.detail).toContain(detailNeedle);
    expect(warned.join(' ')).toContain(reason);
    expect(`${line}${warned.join(' ')}`).not.toContain('sb_test_token_value_0123');
  });

  it('names the candidate list when nothing answered — "could not ask" has to say where', async () => {
    stubBox(() => ({ body: '' }), { health: () => 0 });
    const { line } = await runChannelCommand();
    const parsed = JSON.parse(line) as { tried: string[] };
    expect(parsed.tried[0]).toBe('https://box.example.tld');
    expect(parsed.tried.at(-1)).toBe(INTERNAL_BOX_ORIGIN);
  });

  it('a well-formed reply with no channel field is a failed read, not an empty channel', async () => {
    stubBox(() => ({ body: sseOf({}) }));
    const { code, line } = await runChannelCommand();
    expect(code).toBe(2);
    expect(JSON.parse(line)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it("a refusal carries the box's own reason", async () => {
    stubBox(() => ({ body: sseOf("Token scope 'read' required for get_channel", true) }));
    const r = await readChannel();
    expect(r).toMatchObject({ ok: false, reason: 'refused' });
    expect(channelExitCode(r)).toBe(2);
  });

  it('getChannel keeps its null for the in-process pollers — "not yet" is not a verdict', async () => {
    stubBox(() => ({ body: '' }), { health: () => 0 });
    await expect(getChannel()).resolves.toBeNull();
    expect(channelResultLine({ ok: true, channel: 'latest' })).toEqual({ channel: 'latest', ok: true });
  });

  it('the CLI branch goes through channelCommand and exits on its code — not a bare exit 0', () => {
    const src = readFileSync('scripts/autoloop-box.ts', 'utf8');
    const branch = src.slice(src.indexOf("case 'channel': {"), src.indexOf("case 'channel-set'"));
    expect(branch).toContain('channelCommand()');
    expect(branch).toMatch(/process\.exit\(code\)/);
    expect(branch).not.toContain('await getChannel()');
  });
});

type ChannelReadFailureCase = 'unreachable' | 'unauthorized' | 'timeout' | 'malformed';
