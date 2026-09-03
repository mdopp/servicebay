/**
 * /api/settings/backup-sync — the SMB credential is write-only (#2771).
 *
 * The GET used to hand back `config.backup` verbatim, so every Settings →
 * Backup load round-tripped the live SMB share password into the browser and
 * into React state. These cases pin the two halves of the fix, the same
 * write-only shape `external-backup/target` already uses:
 *   1. GET reports `hasPassword` and never the value itself;
 *   2. a save that leaves the field untouched (blank password) keeps the
 *      stored secret server-side instead of wiping it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { BackupConfig } from '@/lib/backup/types';

const SECRET = 'sup3r-secret-share-pw';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getBackupHistory: vi.fn(async () => [] as unknown[]),
  isBackupRunning: vi.fn(() => false),
  runBackup: vi.fn(),
  testBackupTarget: vi.fn(async () => ({ success: true, message: 'ok' })),
  scheduleBackup: vi.fn(),
  getChecks: vi.fn((): unknown[] => []),
  saveCheck: vi.fn(),
  deleteCheck: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  getConfig: mocks.getConfig,
  updateConfig: mocks.updateConfig,
}));

vi.mock('@/lib/backup/service', () => ({
  runBackup: mocks.runBackup,
  getBackupHistory: mocks.getBackupHistory,
  isBackupRunning: mocks.isBackupRunning,
  testBackupTarget: mocks.testBackupTarget,
  scheduleBackup: mocks.scheduleBackup,
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getChecks: mocks.getChecks,
    saveCheck: mocks.saveCheck,
    deleteCheck: mocks.deleteCheck,
  },
}));

// Mirrors the real wrapper: parse the body with the route's OWN schema, 400 on
// a ZodError, pass a Response back untouched.
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      opts: { body?: z.ZodType<unknown> },
      handler: (ctx: { body: unknown; request: NextRequest }) => Promise<unknown>,
    ) =>
    async (request: NextRequest) => {
      let body: unknown;
      if (opts.body) {
        try {
          body = opts.body.parse(await request.json());
        } catch {
          return NextResponse.json({ error: 'bad request' }, { status: 400 });
        }
      }
      const result = await handler({ body, request });
      return result instanceof Response ? result : NextResponse.json(result);
    },
}));

import { GET, POST } from './route';

const BASE = 'http://localhost:5888/api/settings/backup-sync';

const smbConfig = (): BackupConfig => ({
  enabled: true,
  schedule: 'daily',
  time: '02:00',
  target: { type: 'smb', host: 'nas.local', share: 'backup', username: 'sb', password: SECRET },
  sources: [{ path: '/mnt/data' }],
});

function post(body: unknown) {
  return POST(
    new NextRequest(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/settings/backup-sync — the stored password never leaves the box (#2771)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBackupHistory.mockResolvedValue([]);
    mocks.isBackupRunning.mockReturnValue(false);
    mocks.getChecks.mockReturnValue([]);
  });

  it('reports hasPassword instead of the value for an smb target', async () => {
    mocks.getConfig.mockResolvedValue({ backup: smbConfig() });

    const res = await GET(new NextRequest(BASE, { method: 'GET' }));
    const data = await res.json();

    expect(data.config.target).toMatchObject({ type: 'smb', host: 'nas.local', hasPassword: true });
    expect(data.config.target.password).toBeUndefined();
    // Belt and braces: the secret must not appear anywhere in the payload.
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it('reports hasPassword false when no secret is stored', async () => {
    const config = smbConfig();
    config.target = { type: 'smb', host: 'nas.local', share: 'backup' };
    mocks.getConfig.mockResolvedValue({ backup: config });

    const data = await (await GET(new NextRequest(BASE, { method: 'GET' }))).json();
    expect(data.config.target.hasPassword).toBe(false);
  });

  it('leaves a non-smb target and the rest of the config untouched', async () => {
    mocks.getConfig.mockResolvedValue({
      backup: { ...smbConfig(), target: { type: 'local', path: '/mnt/backup' }, lastStatus: 'success' },
    });

    const data = await (await GET(new NextRequest(BASE, { method: 'GET' }))).json();
    expect(data.config.target).toEqual({ type: 'local', path: '/mnt/backup' });
    expect(data.config.lastStatus).toBe('success');
    expect(data.config.schedule).toBe('daily');
  });
});

describe('POST save — a blank password keeps the stored secret (#2771)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChecks.mockReturnValue([]);
    mocks.getConfig.mockResolvedValue({ backup: smbConfig() });
  });

  it('preserves the stored secret when the form sends no password', async () => {
    await post({
      action: 'save',
      config: {
        ...smbConfig(),
        target: { type: 'smb', host: 'nas.local', share: 'backup', username: 'sb' },
      },
    });

    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
    const saved = mocks.updateConfig.mock.calls[0][0].backup as BackupConfig;
    expect(saved.target).toMatchObject({ type: 'smb', password: SECRET });
  });

  it('takes a newly typed password over the stored one', async () => {
    await post({
      action: 'save',
      config: {
        ...smbConfig(),
        target: { type: 'smb', host: 'nas.local', share: 'backup', username: 'sb', password: 'rotated' },
      },
    });

    const saved = mocks.updateConfig.mock.calls[0][0].backup as BackupConfig;
    expect(saved.target).toMatchObject({ password: 'rotated' });
  });

  it('does not resurrect a secret when the operator switches share hosts away from smb', async () => {
    await post({
      action: 'save',
      config: { ...smbConfig(), target: { type: 'local', path: '/mnt/backup' } },
    });

    const saved = mocks.updateConfig.mock.calls[0][0].backup as BackupConfig;
    expect(saved.target).toEqual({ type: 'local', path: '/mnt/backup' });
  });

  it('tests the target with the stored secret when the form field is blank', async () => {
    await post({
      action: 'test',
      target: { type: 'smb', host: 'nas.local', share: 'backup', username: 'sb' },
    });

    expect(mocks.testBackupTarget).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'smb', password: SECRET }),
      expect.anything(),
    );
  });
});
