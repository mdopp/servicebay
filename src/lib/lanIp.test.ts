import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn() },
}));
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

import { recentChanges, dateNDaysAgo, reconcileLanIp } from './lanIp';
import { agentManager } from '@/lib/agent/manager';
import { getConfig, updateConfig } from '@/lib/config';

const today = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
};

describe('recentChanges', () => {
  it('returns 0 for an empty history', () => {
    expect(recentChanges([], 30)).toBe(0);
  });

  it('returns 0 for a single distinct IP within window', () => {
    expect(recentChanges([{ ip: '10.0.0.5', detectedAt: today(1) }], 30)).toBe(0);
  });

  it('counts distinct-IP transitions within the window only', () => {
    const history = [
      { ip: '10.0.0.5', detectedAt: today(2) },
      { ip: '10.0.0.6', detectedAt: today(1) },
      { ip: '10.0.0.5', detectedAt: today(0) },
    ];
    // Distinct IPs in window = 2; changes = 1
    expect(recentChanges(history, 30)).toBe(1);
  });

  it('ignores entries older than the window', () => {
    const history = [
      { ip: '10.0.0.4', detectedAt: today(60) }, // outside window
      { ip: '10.0.0.5', detectedAt: today(20) },
      { ip: '10.0.0.6', detectedAt: today(5) },
      { ip: '10.0.0.7', detectedAt: today(1) },
    ];
    // Within 30 days: 3 distinct → 2 changes
    expect(recentChanges(history, 30)).toBe(2);
  });
});

describe('dateNDaysAgo', () => {
  it('returns a Date in the past', () => {
    const d = dateNDaysAgo(7);
    expect(d.getTime()).toBeLessThan(Date.now());
    expect(Date.now() - d.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
  });
});

describe('reconcileLanIp', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockEnsureAgent = agentManager.ensureAgent as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockGetConfig = getConfig as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockUpdateConfig = updateConfig as any;

  function fakeAgent(stdout: string, code = 0) {
    return { sendCommand: vi.fn().mockResolvedValue({ code, stdout }) };
  }

  beforeEach(() => {
    mockEnsureAgent.mockReset();
    mockGetConfig.mockReset();
    mockUpdateConfig.mockReset();
  });

  it('writes the install-time IP on first run with no stored value', async () => {
    mockEnsureAgent.mockResolvedValue(fakeAgent('192.168.1.50\n'));
    mockGetConfig.mockResolvedValue({ reverseProxy: {} });
    const ip = await reconcileLanIp('Local');
    expect(ip).toBe('192.168.1.50');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      reverseProxy: { lanIp: '192.168.1.50', lanIpHistory: [] },
    });
  });

  it('no-ops when current IP matches stored', async () => {
    mockEnsureAgent.mockResolvedValue(fakeAgent('10.0.0.5'));
    mockGetConfig.mockResolvedValue({
      reverseProxy: { lanIp: '10.0.0.5', lanIpHistory: [] },
    });
    const ip = await reconcileLanIp('Local');
    expect(ip).toBe('10.0.0.5');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('appends the previous IP to history when it changes', async () => {
    mockEnsureAgent.mockResolvedValue(fakeAgent('10.0.0.6'));
    mockGetConfig.mockResolvedValue({
      reverseProxy: { lanIp: '10.0.0.5', lanIpHistory: [] },
    });
    const ip = await reconcileLanIp('Local');
    expect(ip).toBe('10.0.0.6');
    const call = mockUpdateConfig.mock.calls[0][0];
    expect(call.reverseProxy.lanIp).toBe('10.0.0.6');
    expect(call.reverseProxy.lanIpHistory).toHaveLength(1);
    expect(call.reverseProxy.lanIpHistory[0].ip).toBe('10.0.0.5');
  });

  it('returns null and writes nothing when detection fails', async () => {
    mockEnsureAgent.mockResolvedValue(fakeAgent('', 1));
    mockGetConfig.mockResolvedValue({ reverseProxy: { lanIp: '10.0.0.5' } });
    const ip = await reconcileLanIp('Local');
    expect(ip).toBeNull();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
