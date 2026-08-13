import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSettingsEnv,
  extractToken,
  buildMcpBody,
  parseMcpExecResult,
  parseMcpToolResult,
  normaliseBoxUrl,
  backoffMs,
  setChannel,
  getChannel,
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

function stubBox(reply: (call: Captured) => { body: string; status?: number } | Promise<never>): Captured[] {
  const calls: Captured[] = [];
  vi.stubEnv('SB_BOX_URL', 'https://box.example.tld');
  vi.stubEnv('SB_TOKEN', 'sb_test_token_value_0123');
  vi.stubGlobal('fetch', async (url: string, init: Captured['init'] = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const res = await reply(call);
    return { status: res.status ?? 200, text: async () => res.body } as unknown as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('setChannel', () => {
  it('flips via the MCP set_channel tool with the Bearer token — never an admin login', async () => {
    const calls = stubBox(() => ({ body: sseOf({ ok: true, channel: 'dev' }) }));
    await setChannel('dev');
    expect(calls).toHaveLength(1);
    const [call] = calls as [Captured];
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
    expect(JSON.parse((calls[0] as Captured).init.body as string)).toMatchObject({
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
    expect(JSON.parse((calls[0] as Captured).init.body as string)).toMatchObject({
      params: { name: 'get_channel', arguments: {} },
    });
  });

  it('returns null when the box does not answer — "not yet", never a verdict', async () => {
    stubBox(() => Promise.reject(new Error('ECONNREFUSED')) as Promise<never>);
    await expect(getChannel()).resolves.toBeNull();
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
