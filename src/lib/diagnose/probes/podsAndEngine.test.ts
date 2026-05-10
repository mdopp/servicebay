 
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { sendCommand: vi.fn() };

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

import { dispatchProbeAction } from '../actions';
import './podsAndEngine';

beforeEach(() => {
  mockAgent.sendCommand.mockReset();
});

describe('pods.start_pod', () => {
  it('rejects unsafe names', async () => {
    const result = await dispatchProbeAction({
      probeId: 'pods',
      actionId: 'start_pod',
      itemId: '`evil`',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockAgent.sendCommand).not.toHaveBeenCalled();
  });

  it('starts via systemctl on the happy path', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0 });
    const result = await dispatchProbeAction({
      probeId: 'pods',
      actionId: 'start_pod',
      itemId: 'auth',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockAgent.sendCommand.mock.calls[0][1].command).toContain('systemctl --user start auth.service');
  });

  it('falls back to podman pod start when the unit is missing', async () => {
    mockAgent.sendCommand
      .mockResolvedValueOnce({ code: 5, stderr: 'Unit not found.' })
      .mockResolvedValueOnce({ code: 0 });
    const result = await dispatchProbeAction({
      probeId: 'pods',
      actionId: 'start_pod',
      itemId: 'orphan',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockAgent.sendCommand.mock.calls[1][1].command).toContain('podman pod start orphan');
  });
});

describe('podman.enable_socket', () => {
  it('runs the enable+start command', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0 });
    const result = await dispatchProbeAction({
      probeId: 'podman',
      actionId: 'enable_socket',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockAgent.sendCommand.mock.calls[0][1].command).toContain('systemctl --user enable --now podman.socket');
  });

  it('returns failure with stderr when the command fails', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({
      code: 1,
      stderr: 'Failed to enable: PolicyKit refused.',
    });
    const result = await dispatchProbeAction({
      probeId: 'podman',
      actionId: 'enable_socket',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/PolicyKit refused/);
  });
});
