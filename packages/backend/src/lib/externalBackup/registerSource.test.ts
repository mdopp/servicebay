import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig, mockUpdateConfig, mockTestNas, mockListBackups, mockResolveTarget } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
  mockTestNas: vi.fn(),
  mockListBackups: vi.fn(),
  mockResolveTarget: vi.fn(),
}));

vi.mock('../config', () => ({
  getConfig: () => mockGetConfig(),
  updateConfig: (u: unknown) => mockUpdateConfig(u),
}));
vi.mock('./nasClient', () => ({
  testNasConnection: () => mockTestNas(),
  resolveBackupTarget: () => mockResolveTarget(),
}));
vi.mock('./producer', () => ({ listServiceBackups: () => mockListBackups() }));

import {
  registerNasSource,
  getNasBackupOverview,
  getExternalBackupTargetView,
  saveExternalBackupTarget,
} from './registerSource';

const REG = { host: '192.168.178.1', username: 'fritz9746', password: 'pw' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({});
  mockUpdateConfig.mockResolvedValue({});
  mockTestNas.mockResolvedValue({ ok: true });
  // Default: no destination resolves (not configured). Configured tests below
  // set a non-null resolved target.
  mockResolveTarget.mockResolvedValue(null);
  mockListBackups.mockResolvedValue([{ service: 'home-assistant', tarName: 'home-assistant-20260615-0531.tar', size: 2_340_000, stamp: '20260615-0531' }]);
});

const FTP_TARGET = { transport: 'ftp', host: '192.168.178.1', user: 'fritz9746', password: 'pw', secure: false };

describe('registerNasSource', () => {
  it('writes the FritzBox gateway when none is configured', async () => {
    const r = await registerNasSource(REG);
    expect(r.changed).toBe(true);
    expect(r.gateway).toEqual({ type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746' });
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746', password: 'pw' },
    });
  });

  it('is a no-op when the same creds are already registered', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    const r = await registerNasSource(REG);
    expect(r.changed).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('updates a rotated password while preserving other gateway fields', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746', password: 'old', ssl: true } });
    const r = await registerNasSource({ ...REG, password: 'new' });
    expect(r.changed).toBe(true);
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746', password: 'new', ssl: true },
    });
  });

  it('trims surrounding whitespace on host/username', async () => {
    await registerNasSource({ host: '  192.168.178.1 ', username: ' fritz9746 ', password: 'pw' });
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: expect.objectContaining({ host: '192.168.178.1', username: 'fritz9746' }) }),
    );
  });

  it.each([
    ['host', { host: '', username: 'u', password: 'p' }],
    ['username', { host: 'h', username: '', password: 'p' }],
    ['password', { host: 'h', username: 'u', password: '' }],
  ])('rejects a missing %s', async (_field, reg) => {
    await expect(registerNasSource(reg)).rejects.toThrow(/required/);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('getNasBackupOverview', () => {
  it('reports not-configured when no FritzBox gateway is set', async () => {
    const o = await getNasBackupOverview();
    expect(o).toEqual({ configured: false, connection: null, backups: [] });
    expect(mockTestNas).not.toHaveBeenCalled();
  });

  it('lists NAS backups when configured and connected', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    mockResolveTarget.mockResolvedValue(FTP_TARGET);
    const o = await getNasBackupOverview();
    expect(o.configured).toBe(true);
    expect(o.connection).toEqual({ ok: true });
    expect(o.backups).toEqual([{ service: 'home-assistant', tarName: 'home-assistant-20260615-0531.tar', size: 2_340_000, stamp: '20260615-0531' }]);
  });

  it('surfaces a connection failure with no backups', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    mockResolveTarget.mockResolvedValue(FTP_TARGET);
    mockTestNas.mockResolvedValue({ ok: false, error: '530 Login incorrect' });
    const o = await getNasBackupOverview();
    expect(o.connection).toEqual({ ok: false, error: '530 Login incorrect' });
    expect(o.backups).toEqual([]);
    expect(mockListBackups).not.toHaveBeenCalled();
  });

  it('treats a connected-but-listing-failed NAS as empty', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    mockResolveTarget.mockResolvedValue(FTP_TARGET);
    mockListBackups.mockRejectedValue(new Error('sb-backup: No such directory'));
    const o = await getNasBackupOverview();
    expect(o.connection).toEqual({ ok: true });
    expect(o.backups).toEqual([]);
  });
});

describe('getExternalBackupTargetView (#1525/#1527)', () => {
  it('reports the gateway-inheriting fritzbox default with the password masked', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    const v = await getExternalBackupTargetView();
    expect(v).toMatchObject({ type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746', hasPassword: true, inheritsGateway: true });
    expect(v).not.toHaveProperty('password');
  });

  it('flags a fritzbox override as not inheriting the gateway', async () => {
    mockGetConfig.mockResolvedValue({
      gateway: { type: 'fritzbox', ...REG },
      externalBackup: { enabled: true, target: { type: 'fritzbox', username: 'nasuser', password: 'naspw' } },
    });
    const v = await getExternalBackupTargetView();
    expect(v).toMatchObject({ type: 'fritzbox', username: 'nasuser', hasPassword: true, inheritsGateway: false });
  });

  it('masks an FTP target password', async () => {
    mockGetConfig.mockResolvedValue({
      externalBackup: { enabled: true, target: { type: 'ftp', host: 'ftp.example.com', username: 'u', password: 'secret', dir: 'b' } },
    });
    const v = await getExternalBackupTargetView();
    expect(v).toMatchObject({ type: 'ftp', host: 'ftp.example.com', username: 'u', hasPassword: true, dir: 'b' });
    expect(JSON.stringify(v)).not.toContain('secret');
  });
});

describe('saveExternalBackupTarget (#1527)', () => {
  it('persists a fritzbox target, preserving enabled/time', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: false, time: '04:00' } });
    await saveExternalBackupTarget({ type: 'fritzbox', secure: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      externalBackup: { enabled: false, time: '04:00', target: { type: 'fritzbox', secure: true } },
    });
  });

  it('defaults enabled:true when externalBackup was unset', async () => {
    mockGetConfig.mockResolvedValue({});
    await saveExternalBackupTarget({ type: 'ftp', host: 'h', username: 'u', password: 'p' });
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ externalBackup: expect.objectContaining({ enabled: true }) }),
    );
  });

  it('keeps the stored FTP password when the form sends a blank one', async () => {
    mockGetConfig.mockResolvedValue({
      externalBackup: { enabled: true, target: { type: 'ftp', host: 'h', username: 'u', password: 'kept' } },
    });
    await saveExternalBackupTarget({ type: 'ftp', host: 'h', username: 'u', password: '' });
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ externalBackup: expect.objectContaining({ target: expect.objectContaining({ password: 'kept' }) }) }),
    );
  });

  it('keeps the stored SSH key when the form sends a blank one', async () => {
    mockGetConfig.mockResolvedValue({
      externalBackup: { enabled: true, target: { type: 'ssh', host: 'h', username: 'u', privateKey: 'KEY' } },
    });
    await saveExternalBackupTarget({ type: 'ssh', host: 'h', username: 'u', privateKey: '' });
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ externalBackup: expect.objectContaining({ target: expect.objectContaining({ privateKey: 'KEY' }) }) }),
    );
  });
});
