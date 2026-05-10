/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { sendCommand: vi.fn() };
let mockConfig: any = {};
const savedConfigs: any[] = [];

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
  updateConfig: vi.fn((updates: any) => {
    mockConfig = { ...mockConfig, ...updates, servicePostDeploy: { ...(mockConfig.servicePostDeploy ?? {}), ...(updates.servicePostDeploy ?? {}) } };
    savedConfigs.push({ ...mockConfig });
    return Promise.resolve(mockConfig);
  }),
  saveConfig: vi.fn((cfg: any) => {
    mockConfig = cfg;
    savedConfigs.push({ ...mockConfig });
    return Promise.resolve();
  }),
}));

import { dispatchProbeAction } from '../actions';
import './postDeployFailed';

beforeEach(() => {
  mockAgent.sendCommand.mockReset();
  mockConfig = {};
  savedConfigs.length = 0;
});

describe('post_deploy_failed.dismiss_post_deploy', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'dismiss_post_deploy',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(savedConfigs).toHaveLength(0);
  });

  it('returns failure when no record matches', async () => {
    mockConfig = { servicePostDeploy: { vault: { exitCode: 1, lastRunAt: '2026-05-09T00:00:00Z' } } };
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'dismiss_post_deploy',
      itemId: 'unknown-service',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no post-deploy record/i);
  });

  it('removes the named entry while preserving siblings', async () => {
    mockConfig = {
      reverseProxy: { lanIp: '192.168.0.10' },
      servicePostDeploy: {
        vault: { exitCode: 1, lastRunAt: '2026-05-09T00:00:00Z' },
        immich: { exitCode: 0, lastRunAt: '2026-05-09T00:01:00Z' },
      },
    };
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'dismiss_post_deploy',
      itemId: 'vault',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockConfig.servicePostDeploy).toEqual({
      immich: { exitCode: 0, lastRunAt: '2026-05-09T00:01:00Z' },
    });
    // Sibling config keys must survive — saveConfig writes the whole
    // object, so the dismiss handler can't accidentally drop them.
    expect(mockConfig.reverseProxy).toEqual({ lanIp: '192.168.0.10' });
  });
});

describe('post_deploy_failed.rerun_post_deploy', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'rerun_post_deploy',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockAgent.sendCommand).not.toHaveBeenCalled();
  });

  it('reports missing artifacts when scripts no longer on disk', async () => {
    // First call is the test -f check; respond with anything other than 'ok'
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'rerun_post_deploy',
      itemId: 'vault',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Couldn't find the original post-deploy/);
    // Only the test-f probe should have run; the python invocation
    // must not have fired.
    expect(mockAgent.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('persists the new exit code on a successful re-run', async () => {
    mockAgent.sendCommand
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'seed completed', stderr: '' });
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'rerun_post_deploy',
      itemId: 'vault',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockConfig.servicePostDeploy?.vault?.exitCode).toBe(0);
    expect(mockConfig.servicePostDeploy?.vault?.stdoutTail).toBe('seed completed');
  });

  it('persists exit code and surfaces the last log line on failure', async () => {
    mockAgent.sendCommand
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' })
      .mockResolvedValueOnce({
        code: 5,
        stdout: 'connecting...\nbackoff retry...\n[ERROR] LLDAP refused connection',
        stderr: '',
      });
    const result = await dispatchProbeAction({
      probeId: 'post_deploy_failed',
      actionId: 'rerun_post_deploy',
      itemId: 'vault',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/exit 5/);
    expect(result.message).toMatch(/LLDAP refused connection/);
    expect(mockConfig.servicePostDeploy?.vault?.exitCode).toBe(5);
  });
});
