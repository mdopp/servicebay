import { describe, it, expect, beforeEach, vi } from 'vitest';

// Record every socket.connect so we can prove a malformed host never opens a
// connection (the js/request-forgery barrier in checkTcpConnection).
const connectCalls: { port: number; host: string }[] = [];

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>();
  class FakeSocket {
    private handlers: Record<string, (() => void)[]> = {};
    setTimeout() {}
    on(event: string, cb: () => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    destroy() {}
    connect(port: number, host: string) {
      connectCalls.push({ port, host });
      // Simulate an immediate connect so a *valid* host resolves true.
      queueMicrotask(() => this.handlers['connect']?.forEach((cb) => cb()));
    }
  }
  return { ...actual, Socket: FakeSocket, isIP: actual.isIP };
});

describe('checkTcpConnection host barrier', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    vi.resetModules();
  });

  it('connects for a valid host', async () => {
    const { checkTcpConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await checkTcpConnection('192.168.178.100', 5888);
    expect(ok).toBe(true);
    expect(connectCalls).toEqual([{ port: 5888, host: '192.168.178.100' }]);
  });

  it('rejects a malformed/SSRF host without opening a socket', async () => {
    const { checkTcpConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await checkTcpConnection('http://evil.example/x', 5888);
    expect(ok).toBe(false);
    expect(connectCalls).toHaveLength(0);
  });

  it('rejects an out-of-range port without opening a socket', async () => {
    const { checkTcpConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await checkTcpConnection('box.local', 70000);
    expect(ok).toBe(false);
    expect(connectCalls).toHaveLength(0);
  });
});
