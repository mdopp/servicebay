import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock hoists above top-level const, so expose mutable state via a closure.
const state = {
  target: null as { host: string; user: string; password: string; secure: boolean } | null,
  conn: { ok: true } as { ok: true } | { ok: false; error: string },
  uploadThrows: null as Error | null,
};

vi.mock('@/lib/externalBackup/nasClient', () => ({
  getNasTarget: vi.fn(() => Promise.resolve(state.target)),
  testNasConnection: vi.fn(() => Promise.resolve(state.conn)),
  nasUpload: vi.fn(() => (state.uploadThrows ? Promise.reject(state.uploadThrows) : Promise.resolve())),
  nasRemove: vi.fn(() => Promise.resolve()),
  nasDownload: vi.fn(() => Promise.resolve(Buffer.from(''))),
  nasList: vi.fn(() => Promise.resolve([])),
}));

import { checkNasBackupReachable } from './nasBackupReachable';

beforeEach(() => {
  state.target = { host: '192.168.178.1', user: 'fritz', password: 'pw', secure: false };
  state.conn = { ok: true };
  state.uploadThrows = null;
});

describe('checkNasBackupReachable', () => {
  it('returns info when no NAS is configured', async () => {
    state.target = null;
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/not configured/);
  });

  it('warns with a sharing hint when the NAS is unreachable', async () => {
    state.conn = { ok: false, error: 'connect ECONNREFUSED 192.168.178.1:21' };
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Could not reach/);
    expect(r.hint).toMatch(/attach a USB drive/i);
  });

  it('warns with a credentials hint when authentication fails', async () => {
    state.conn = { ok: false, error: '530 Login incorrect' };
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/authentication failed/);
    expect(r.hint).toMatch(/username\/password/);
  });

  it('warns when connected but the write test fails (read-only / no drive)', async () => {
    state.uploadThrows = new Error('550 Permission denied');
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/writing to sb-backup\/ failed/);
    expect(r.detail).toMatch(/Permission denied/);
    expect(r.hint).toMatch(/attach a USB drive/i);
  });

  it('does not tell the operator to attach a drive when the share is simply full (#2873)', async () => {
    state.uploadThrows = new Error('553 .sb-write-test-1-2: No space left on device.');
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/No space left on device/);
    expect(r.hint).toMatch(/out of space/i);
    expect(r.hint).toMatch(/prunes the oldest snapshots/i);
    expect(r.hint).not.toMatch(/attach a USB drive/i);
  });

  it('removes its own write-test file after a failed write test (#2873)', async () => {
    const { nasRemove } = await import('@/lib/externalBackup/nasClient');
    vi.mocked(nasRemove).mockClear();
    state.uploadThrows = new Error('553 out of space: No space left on device.');
    await checkNasBackupReachable();
    const removed = vi.mocked(nasRemove).mock.calls.map(c => String(c[0]));
    expect(removed.some(pth => pth.startsWith('sb-backup/.sb-write-test-'))).toBe(true);
  });

  it('returns ok when reachable, authed, and writable', async () => {
    const r = await checkNasBackupReachable();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/reachable and writable/);
    expect(r.hint).toBeUndefined();
  });
});
