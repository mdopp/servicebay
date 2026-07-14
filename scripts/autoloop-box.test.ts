import { describe, it, expect } from 'vitest';
import { parseSettingsEnv, extractToken, buildMcpBody, parseMcpExecResult, backoffMs } from './autoloop-box';

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
