 
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { sendCommand: vi.fn() };

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

import {
  registerProbeAction as _registerProbeAction,
  dispatchProbeAction,
} from '../actions';
// Side-effect import that registers the crash_loop actions.
import './crashLoop';

beforeEach(() => {
  mockAgent.sendCommand.mockReset();
  // crashLoop registers handlers at module load. The reset would
  // unregister them, so we re-import to repopulate. Vitest module
  // graph caches the import — explicit re-register via the module
  // we already imported.
  void _registerProbeAction;
});

describe('crash_loop probe actions', () => {
  describe('restart_pod', () => {
    it('rejects unsafe container names', async () => {
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'restart_pod',
        itemId: 'foo;rm -rf /',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/unsafe/i);
      expect(mockAgent.sendCommand).not.toHaveBeenCalled();
    });

    it('rejects empty itemId', async () => {
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'restart_pod',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no container/i);
      expect(mockAgent.sendCommand).not.toHaveBeenCalled();
    });

    it('runs systemctl restart for safe names', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'restart_pod',
        itemId: 'vaultwarden',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Restarted vaultwarden\.service/);
      expect(mockAgent.sendCommand).toHaveBeenCalledWith(
        'exec',
        expect.objectContaining({ command: expect.stringContaining('systemctl --user restart vaultwarden.service') }),
        expect.any(Object),
      );
    });

    it('falls back to podman restart when systemctl returns non-zero', async () => {
      mockAgent.sendCommand
        .mockResolvedValueOnce({ code: 5, stderr: 'Unit not found.', stdout: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'restart_pod',
        itemId: 'sidecar-container',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Restarted container sidecar-container/);
      expect(mockAgent.sendCommand).toHaveBeenCalledTimes(2);
      expect(mockAgent.sendCommand.mock.calls[1][1].command).toContain('podman restart sidecar-container');
    });

    it('returns failure when both unit and podman restart fail', async () => {
      mockAgent.sendCommand
        .mockResolvedValueOnce({ code: 1, stderr: 'unit lookup failed', stdout: '' })
        .mockResolvedValueOnce({ code: 1, stderr: 'no such container', stdout: '' });
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'restart_pod',
        itemId: 'nope',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no such container/);
    });
  });

  describe('show_recent_logs', () => {
    it('returns details with log content on success', async () => {
      const log = ['line 1 of log', 'line 2', 'error: connection refused'].join('\n');
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: log, stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'show_recent_logs',
        itemId: 'vaultwarden',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
      expect(result.details).toBe(log);
      expect(result.message).toMatch(/3 log lines/);
    });

    it('handles empty log output', async () => {
      mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'show_recent_logs',
        itemId: 'vaultwarden',
        node: 'Local',
      });
      expect(result.ok).toBe(true);
      expect(result.details).toBeUndefined();
      expect(result.message).toMatch(/No recent logs/);
    });

    it('rejects unsafe names without invoking the agent', async () => {
      const result = await dispatchProbeAction({
        probeId: 'crash_loop',
        actionId: 'show_recent_logs',
        itemId: '$(curl evil)',
        node: 'Local',
      });
      expect(result.ok).toBe(false);
      expect(mockAgent.sendCommand).not.toHaveBeenCalled();
    });
  });
});
