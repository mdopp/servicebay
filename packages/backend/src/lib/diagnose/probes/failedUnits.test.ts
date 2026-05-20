 
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { sendCommand: vi.fn() };

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

import { dispatchProbeAction } from '../actions';
import './failedUnits';

beforeEach(() => {
  mockAgent.sendCommand.mockReset();
});

describe('failed_units probe actions', () => {
  describe('reset_failed', () => {
    it('runs systemctl reset-failed for safe names', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'reset_failed',
        itemId: 'nginx.service',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
      expect(mockAgent.sendCommand).toHaveBeenCalledWith(
        'exec',
        expect.objectContaining({ command: expect.stringContaining('systemctl --user reset-failed nginx.service') }),
        expect.any(Object),
      );
    });

    it('rejects shell metas in unit names', async () => {
      const result = await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'reset_failed',
        itemId: 'nginx.service && curl evil',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(mockAgent.sendCommand).not.toHaveBeenCalled();
    });

    it('accepts template units (with @)', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'reset_failed',
        itemId: 'getty@tty1.service',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
    });

    it('returns failure with stderr when systemctl errors', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({
        code: 1,
        stderr: 'Failed to reset failed state of unit foo.service: Unit not loaded',
        stdout: '',
      });
      const result = await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'reset_failed',
        itemId: 'foo.service',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Unit not loaded/);
    });
  });

  describe('restart_unit', () => {
    it('chains reset-failed and restart in a single exec', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'restart_unit',
        itemId: 'auth.service',
        node: 'Local',
      });
      const cmd = mockAgent.sendCommand.mock.calls[0][1].command as string;
      expect(cmd).toContain('reset-failed auth.service');
      expect(cmd).toContain('restart auth.service');
    });

    it('rejects empty itemId', async () => {
      const result = await dispatchProbeAction({
        probeId: 'failed_units',
        actionId: 'restart_unit',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(mockAgent.sendCommand).not.toHaveBeenCalled();
    });
  });
});
