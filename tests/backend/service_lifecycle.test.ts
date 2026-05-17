/**
 * Direct unit test against ServiceLifecycle methods (#589 follow-up AC).
 *
 * Pins the basic shape of the lifecycle module's public surface — it
 * exports a class, the methods are static functions with the expected
 * signatures, and the simple unit-management methods (start/stop/restart)
 * exec the right `systemctl --user --no-block <verb> <name>.service`
 * commands against the agent.
 *
 * The deeper paths (deployKubeService and friends) are still covered
 * end-to-end via the existing `tests/backend/service_manager_*.test.ts`
 * suites — duplicating those at the new module's boundary would just
 * mirror them without adding signal. This file exists to satisfy the
 * ticket's "at least one lifecycle method gets a direct unit test that
 * doesn't go through the public ServiceManager surface" criterion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the agent manager before importing the module under test so the
// static methods see the mocked ensureAgent.
const ensureAgentMock = vi.fn();
vi.mock('../../src/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (...args: unknown[]) => ensureAgentMock(...args) },
}));

import { ServiceLifecycle } from '../../src/lib/services/serviceLifecycle';

describe('ServiceLifecycle (#589 follow-up)', () => {
  let agent: { sendCommand: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    agent = { sendCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }) };
    ensureAgentMock.mockReset();
    ensureAgentMock.mockResolvedValue(agent);
  });

  it('exposes the lifecycle methods as static class members', () => {
    expect(typeof ServiceLifecycle.startService).toBe('function');
    expect(typeof ServiceLifecycle.stopService).toBe('function');
    expect(typeof ServiceLifecycle.restartService).toBe('function');
    expect(typeof ServiceLifecycle.deployKubeService).toBe('function');
    expect(typeof ServiceLifecycle.deleteService).toBe('function');
    expect(typeof ServiceLifecycle.saveService).toBe('function');
    expect(typeof ServiceLifecycle.renameService).toBe('function');
  });

  it('startService issues `systemctl --user --no-block start <name>.service`', async () => {
    await ServiceLifecycle.startService('Local', 'immich');
    expect(ensureAgentMock).toHaveBeenCalledWith('Local');
    expect(agent.sendCommand).toHaveBeenCalledWith('exec', {
      command: 'systemctl --user --no-block start immich.service',
    });
  });

  it('stopService issues the matching stop command', async () => {
    await ServiceLifecycle.stopService('node-2', 'vaultwarden');
    expect(agent.sendCommand).toHaveBeenCalledWith('exec', {
      command: 'systemctl --user --no-block stop vaultwarden.service',
    });
  });

  it('restartService issues restart', async () => {
    await ServiceLifecycle.restartService('Local', 'auth');
    expect(agent.sendCommand).toHaveBeenCalledWith('exec', {
      command: 'systemctl --user --no-block restart auth.service',
    });
  });

  it('reloadDaemon issues `systemctl --user daemon-reload`', async () => {
    await ServiceLifecycle.reloadDaemon('Local');
    expect(agent.sendCommand).toHaveBeenCalledWith('exec', {
      command: 'systemctl --user daemon-reload',
    });
  });

  it('throws when the agent returns a non-zero exit', async () => {
    agent.sendCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'unit not found' });
    await expect(ServiceLifecycle.startService('Local', 'bogus')).rejects.toThrow(/unit not found/);
  });

  it('STACK_MIGRATIONS is readable on the class (#589 location after split)', () => {
    expect(ServiceLifecycle.STACK_MIGRATIONS).toBeTruthy();
    expect(ServiceLifecycle.STACK_MIGRATIONS.auth).toContain('authelia');
    expect(ServiceLifecycle.STACK_MIGRATIONS.auth).toContain('lldap');
  });
});
