import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig, mockUpdateConfig, mockTestNas, mockListBackups } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
  mockTestNas: vi.fn(),
  mockListBackups: vi.fn(),
}));

vi.mock('../config', () => ({
  getConfig: () => mockGetConfig(),
  updateConfig: (u: unknown) => mockUpdateConfig(u),
}));
vi.mock('./nasClient', () => ({ testNasConnection: () => mockTestNas() }));
vi.mock('./producer', () => ({ listServiceBackups: () => mockListBackups() }));

import { registerNasSource, getNasBackupOverview } from './registerSource';

const REG = { host: '192.168.178.1', username: 'fritz9746', password: 'pw' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({});
  mockUpdateConfig.mockResolvedValue({});
  mockTestNas.mockResolvedValue({ ok: true });
  mockListBackups.mockResolvedValue([{ service: 'home-assistant', tarName: 'home-assistant.tar', size: 2_340_000 }]);
});

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
    const o = await getNasBackupOverview();
    expect(o.configured).toBe(true);
    expect(o.connection).toEqual({ ok: true });
    expect(o.backups).toEqual([{ service: 'home-assistant', tarName: 'home-assistant.tar', size: 2_340_000 }]);
  });

  it('surfaces a connection failure with no backups', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    mockTestNas.mockResolvedValue({ ok: false, error: '530 Login incorrect' });
    const o = await getNasBackupOverview();
    expect(o.connection).toEqual({ ok: false, error: '530 Login incorrect' });
    expect(o.backups).toEqual([]);
    expect(mockListBackups).not.toHaveBeenCalled();
  });

  it('treats a connected-but-listing-failed NAS as empty', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', ...REG } });
    mockListBackups.mockRejectedValue(new Error('sb-backup: No such directory'));
    const o = await getNasBackupOverview();
    expect(o.connection).toEqual({ ok: true });
    expect(o.backups).toEqual([]);
  });
});
