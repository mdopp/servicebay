/**
 * The Backup Sync editor never invents a destination (#2872).
 *
 * `/mnt/backup` was hard-coded twice — as the initial `localPath` and as the
 * `c.target || { type: 'local', path: '/mnt/backup' }` fallback — so a box that
 * had never chosen a target rendered as though it had one, and saving that
 * screen wrote a path that has never existed on the node. An unset target is
 * "not configured"; it is never a path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { fetchBackupSyncState, fetchSystemBackups, fetchExternalBackupList } = vi.hoisted(() => ({
  fetchBackupSyncState: vi.fn(),
  fetchSystemBackups: vi.fn(async () => []),
  fetchExternalBackupList: vi.fn(async () => ({ configured: false, connection: null, backups: [] })),
}));

vi.mock('@servicebay/api-client', () => ({
  fetchBackupSyncState,
  fetchSystemBackups,
  fetchExternalBackupList,
}));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import { useBackupState } from './useBackupState';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBackupState — no phantom /mnt/backup', () => {
  it('starts with an empty local path rather than a pre-filled destination', () => {
    const { result } = renderHook(() => useBackupState());
    expect(result.current.backupSync.localPath).toBe('');
  });

  it('leaves the local path empty when the stored config carries no target', async () => {
    fetchBackupSyncState.mockResolvedValue({
      config: { enabled: false, schedule: 'daily', time: '02:00' },
      history: [],
      running: false,
    });
    const { result } = renderHook(() => useBackupState());

    await act(async () => { await result.current.fetchBackupSync(); });

    expect(result.current.backupSync.localPath).toBe('');
    expect(JSON.stringify(result.current.backupSync)).not.toContain('/mnt/backup');
  });

  it('still loads a real local target as-is', async () => {
    fetchBackupSyncState.mockResolvedValue({
      config: { enabled: true, schedule: 'daily', time: '02:00', target: { type: 'local', path: '/mnt/usb-backup' } },
      history: [],
      running: false,
    });
    const { result } = renderHook(() => useBackupState());

    await act(async () => { await result.current.fetchBackupSync(); });

    expect(result.current.backupSync.targetType).toBe('local');
    expect(result.current.backupSync.localPath).toBe('/mnt/usb-backup');
  });

  it('does not leak a local path into an smb target', async () => {
    fetchBackupSyncState.mockResolvedValue({
      config: {
        enabled: true, schedule: 'daily', time: '02:00',
        target: { type: 'smb', host: 'nas.lan', share: 'backup', hasPassword: true },
      },
      history: [],
      running: false,
    });
    const { result } = renderHook(() => useBackupState());

    await act(async () => { await result.current.fetchBackupSync(); });

    expect(result.current.backupSync.targetType).toBe('smb');
    expect(result.current.backupSync.smbHost).toBe('nas.lan');
    expect(result.current.backupSync.localPath).toBe('');
  });
});
