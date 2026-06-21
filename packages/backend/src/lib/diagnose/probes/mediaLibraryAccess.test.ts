/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { sendCommand: vi.fn() };
const listServices = vi.fn();

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: (...args: any[]) => listServices(...args) },
}));

import { dispatchProbeAction } from '../actions';
import { checkMediaLibraryAccess } from './mediaLibraryAccess';
import './mediaLibraryAccess';

beforeEach(() => {
  mockAgent.sendCommand.mockReset();
  listServices.mockReset();
});

describe('checkMediaLibraryAccess', () => {
  it('returns null status (omit row) when media is not installed', async () => {
    listServices.mockResolvedValue([{ name: 'immich' }, { name: 'nginx' }]);
    const r = await checkMediaLibraryAccess('Local');
    expect(r.status).toBeNull();
    expect(r.detail).toMatch(/not installed/i);
  });

  it('returns info + hint when media is installed (action stays visible)', async () => {
    listServices.mockResolvedValue([{ name: 'media' }, { name: 'nginx' }]);
    const r = await checkMediaLibraryAccess('Local');
    // info (never ok): ok would make the diagnose route strip the action.
    expect(r.status).toBe('info');
    expect(r.hint).toMatch(/re-sync/i);
  });
});

describe('media_library_access.resync_jellyfin_access', () => {
  it('re-runs the media post-deploy and reports success', async () => {
    mockAgent.sendCommand
      .mockResolvedValueOnce({ stdout: 'ok' }) // artifact existence check
      .mockResolvedValueOnce({ code: 0, stdout: 'line1\n✅ Jellyfin libraries: 4 public, 2 private (no change).' });
    const r = await dispatchProbeAction({
      probeId: 'media_library_access',
      actionId: 'resync_jellyfin_access',
      node: 'Local',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/re-synced/i);
    // Second call actually runs the on-disk media post-deploy script.
    expect(mockAgent.sendCommand.mock.calls[1][1].command).toMatch(/media\.py/);
  });

  it('fails cleanly when the post-deploy artifacts are missing', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ stdout: 'missing' });
    const r = await dispatchProbeAction({
      probeId: 'media_library_access',
      actionId: 'resync_jellyfin_access',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/artifacts/i);
    // Did not attempt to run the script (only the existence check ran).
    expect(mockAgent.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-zero exit as a failure with the last log line', async () => {
    mockAgent.sendCommand
      .mockResolvedValueOnce({ stdout: 'ok' })
      .mockResolvedValueOnce({ code: 1, stdout: 'doing things\nBOOM: token expired' });
    const r = await dispatchProbeAction({
      probeId: 'media_library_access',
      actionId: 'resync_jellyfin_access',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exit 1/);
    expect(r.message).toMatch(/token expired/);
  });
});
