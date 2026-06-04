/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendCommand = vi.fn();
const ensureAgent = vi.fn(() => Promise.resolve({ sendCommand }));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (n: string) => ensureAgent(n) },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let configValue: any = {
  reverseProxy: { lanIp: '192.168.178.100' },
  gateway: { type: 'fritzbox', host: '192.168.178.1' },
};
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(configValue)),
}));

import { repointBoxResolverToAdguard } from './boxResolverDns';

beforeEach(() => {
  vi.clearAllMocks();
  configValue = {
    reverseProxy: { lanIp: '192.168.178.100' },
    gateway: { type: 'fritzbox', host: '192.168.178.1' },
  };
});

describe('repointBoxResolverToAdguard', () => {
  it('points DNS at AdGuard (127.0.0.1) with the FritzBox as fallback and NO public resolver', async () => {
    sendCommand
      .mockResolvedValueOnce({ stdout: 'Wired connection 1\n', exit_code: 0 }) // find conn
      .mockResolvedValueOnce({ stdout: '', exit_code: 0 }); // mod + reapply
    const r = await repointBoxResolverToAdguard('Local');
    expect(r.result).toBe('ok');
    const modCmd = sendCommand.mock.calls[1][1].command as string;
    expect(modCmd).toContain("ipv4.dns '127.0.0.1 192.168.178.1'");
    expect(modCmd).toContain('ipv4.ignore-auto-dns yes');
    expect(modCmd).not.toContain('8.8.8.8');
    expect(modCmd).not.toContain('1.1.1.1');
  });

  it('derives a .1 router fallback when no gateway host is set', async () => {
    configValue = { reverseProxy: { lanIp: '192.168.178.100' } };
    sendCommand
      .mockResolvedValueOnce({ stdout: 'eno1-conn\n', exit_code: 0 })
      .mockResolvedValueOnce({ stdout: '', exit_code: 0 });
    const r = await repointBoxResolverToAdguard('Local');
    expect(r.result).toBe('ok');
    expect(sendCommand.mock.calls[1][1].command).toContain("'127.0.0.1 192.168.178.1'");
  });

  it('returns no_interface when there is no active wired connection', async () => {
    sendCommand.mockResolvedValueOnce({ stdout: '\n', exit_code: 0 });
    const r = await repointBoxResolverToAdguard('Local');
    expect(r.result).toBe('no_interface');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('returns failed (best-effort) when nmcli exits non-zero', async () => {
    sendCommand
      .mockResolvedValueOnce({ stdout: 'Wired connection 1\n', exit_code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'Error: unknown connection', exit_code: 1 });
    const r = await repointBoxResolverToAdguard('Local');
    expect(r.result).toBe('failed');
    expect(r.detail).toMatch(/unknown connection/);
  });

  it('returns no_agent when the node agent is unreachable', async () => {
    ensureAgent.mockRejectedValueOnce(new Error('agent offline'));
    const r = await repointBoxResolverToAdguard('Local');
    expect(r.result).toBe('no_agent');
  });
});
