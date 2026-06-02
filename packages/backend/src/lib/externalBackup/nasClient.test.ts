import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient, mockGetConfig } = vi.hoisted(() => ({
  mockClient: {
    access: vi.fn(),
    pwd: vi.fn(),
    ensureDir: vi.fn(),
    uploadFrom: vi.fn(),
    downloadTo: vi.fn(),
    list: vi.fn(),
    cd: vi.fn(),
    remove: vi.fn(),
    close: vi.fn(),
  },
  mockGetConfig: vi.fn(),
}));

vi.mock('basic-ftp', () => ({ Client: vi.fn(function () { return mockClient; }) }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));
// ssh2 is exercised only via resolveBackupTarget/testCandidateTarget shape tests
// here; a connection-level stub keeps these unit tests transport-free.
vi.mock('ssh2', () => ({ Client: vi.fn(function () { return { on() {}, connect() {}, end() {} }; }) }));

import {
  getNasTarget,
  resolveBackupTarget,
  testCandidateTarget,
  testNasConnection,
  nasUpload,
  nasDownload,
  nasList,
  nasRemove,
} from './nasClient';

const GW = { gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'fritz9746', password: 'pw' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue(GW);
  mockClient.access.mockResolvedValue(undefined);
  mockClient.pwd.mockResolvedValue('/');
  mockClient.ensureDir.mockResolvedValue(undefined);
  mockClient.uploadFrom.mockResolvedValue(undefined);
  mockClient.downloadTo.mockImplementation(async (sink: NodeJS.WritableStream) => { sink.write(Buffer.from('hello')); });
  mockClient.list.mockResolvedValue([{ name: 'x.tar', size: 10 }]);
  mockClient.cd.mockResolvedValue(undefined);
  mockClient.remove.mockResolvedValue(undefined);
});

describe('getNasTarget', () => {
  it('maps the FritzBox gateway config to an FTP target', async () => {
    expect(await getNasTarget()).toEqual({ host: '192.168.178.1', user: 'fritz9746', password: 'pw', secure: false });
  });
  it('returns null when gateway credentials are incomplete', async () => {
    mockGetConfig.mockResolvedValue({ gateway: { type: 'fritzbox', host: 'h' } });
    expect(await getNasTarget()).toBeNull();
  });
  it('returns null when there is no gateway', async () => {
    mockGetConfig.mockResolvedValue({});
    expect(await getNasTarget()).toBeNull();
  });
});

describe('resolveBackupTarget — configurable destination (#1525/#1527)', () => {
  it('defaults to the gateway FritzBox FTP when no target is set', async () => {
    expect(await resolveBackupTarget()).toEqual({
      transport: 'ftp', host: '192.168.178.1', user: 'fritz9746', password: 'pw', secure: false,
    });
  });

  it('an explicit fritzbox target inherits unset fields from the gateway', async () => {
    mockGetConfig.mockResolvedValue({ ...GW, externalBackup: { enabled: true, target: { type: 'fritzbox', secure: true } } });
    expect(await resolveBackupTarget()).toEqual({
      transport: 'ftp', host: '192.168.178.1', user: 'fritz9746', password: 'pw', secure: true,
    });
  });

  it('a fritzbox target can override the gateway host/user/password', async () => {
    mockGetConfig.mockResolvedValue({
      ...GW,
      externalBackup: { enabled: true, target: { type: 'fritzbox', username: 'nasuser', password: 'naspw' } },
    });
    expect(await resolveBackupTarget()).toEqual({
      transport: 'ftp', host: '192.168.178.1', user: 'nasuser', password: 'naspw', secure: false,
    });
  });

  it('resolves a standalone FTP target', async () => {
    mockGetConfig.mockResolvedValue({
      externalBackup: { enabled: true, target: { type: 'ftp', host: 'ftp.example.com', port: 2121, username: 'u', password: 'p', dir: 'backups' } },
    });
    expect(await resolveBackupTarget()).toEqual({
      transport: 'ftp', host: 'ftp.example.com', user: 'u', password: 'p', secure: false, port: 2121, dir: 'backups',
    });
  });

  it('resolves an SSH target with password auth', async () => {
    mockGetConfig.mockResolvedValue({
      externalBackup: { enabled: true, target: { type: 'ssh', host: 'nas.local', username: 'u', password: 'p' } },
    });
    expect(await resolveBackupTarget()).toEqual({
      transport: 'ssh', host: 'nas.local', port: 22, user: 'u', password: 'p', privateKey: undefined, dir: undefined,
    });
  });

  it('returns null for an incomplete FTP target (no password)', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, target: { type: 'ftp', host: 'h', username: 'u', password: '' } } });
    expect(await resolveBackupTarget()).toBeNull();
  });

  it('returns null for an SSH target with neither password nor key', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, target: { type: 'ssh', host: 'h', username: 'u' } } });
    expect(await resolveBackupTarget()).toBeNull();
  });

  it('getNasTarget returns null for an SSH destination (not an FTP shape)', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, target: { type: 'ssh', host: 'h', username: 'u', password: 'p' } } });
    expect(await getNasTarget()).toBeNull();
  });
});

describe('testCandidateTarget — probe before persisting', () => {
  it('probes a fritzbox candidate over FTP using gateway creds', async () => {
    expect(await testCandidateTarget({ type: 'fritzbox' })).toEqual({ ok: true });
    expect(mockClient.access).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.168.178.1', user: 'fritz9746', secure: false }),
    );
  });
  it('rejects an incomplete candidate without connecting', async () => {
    const r = await testCandidateTarget({ type: 'ftp', host: '', username: '', password: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/incomplete/i);
    expect(mockClient.access).not.toHaveBeenCalled();
  });
});

describe('nas operations', () => {
  it('uploads into a created parent dir using gateway creds', async () => {
    await nasUpload('sb-backup/authelia.tar', Buffer.from('data'));
    expect(mockClient.access).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.168.178.1', user: 'fritz9746', secure: false }),
    );
    expect(mockClient.ensureDir).toHaveBeenCalledWith('sb-backup');
    expect(mockClient.uploadFrom).toHaveBeenCalledWith(expect.anything(), 'authelia.tar');
    expect(mockClient.close).toHaveBeenCalled();
  });
  it('uploads a root-level file without ensureDir', async () => {
    await nasUpload('top.txt', Buffer.from('x'));
    expect(mockClient.ensureDir).not.toHaveBeenCalled();
    expect(mockClient.uploadFrom).toHaveBeenCalledWith(expect.anything(), 'top.txt');
  });
  it('downloads to a buffer', async () => {
    const buf = await nasDownload('sb-backup/x.tar');
    expect(buf.toString()).toBe('hello');
    expect(mockClient.downloadTo).toHaveBeenCalled();
  });
  it('lists a directory by cd-then-bare-list (FritzBox ignores LIST <path>)', async () => {
    expect(await nasList('sb-backup')).toEqual([{ name: 'x.tar', size: 10 }]);
    // Must cd into the dir then list() with no arg — a path arg returns the
    // root on FritzBox FTP, which silently hid every staged backup.
    expect(mockClient.cd).toHaveBeenCalledWith('sb-backup');
    expect(mockClient.list).toHaveBeenCalledWith();
  });
  it('lists the root without a cd when no dir is given', async () => {
    await nasList();
    expect(mockClient.cd).not.toHaveBeenCalled();
    expect(mockClient.list).toHaveBeenCalledWith();
  });
  it('removes a file idempotently', async () => {
    await nasRemove('/sb-backup/x.tar');
    expect(mockClient.remove).toHaveBeenCalledWith('sb-backup/x.tar', true);
  });
  it('closes the client even when an op throws', async () => {
    mockClient.uploadFrom.mockRejectedValueOnce(new Error('boom'));
    await expect(nasUpload('a/b.txt', Buffer.from('x'))).rejects.toThrow('boom');
    expect(mockClient.close).toHaveBeenCalled();
  });
});

describe('testNasConnection', () => {
  it('ok when access + pwd succeed', async () => {
    expect(await testNasConnection()).toEqual({ ok: true });
  });
  it('reports not-configured', async () => {
    mockGetConfig.mockResolvedValue({});
    const r = await testNasConnection();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not configured/i);
  });
  it('reports an auth/connect failure', async () => {
    mockClient.access.mockRejectedValueOnce(new Error('530 Login incorrect'));
    const r = await testNasConnection();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Login incorrect/);
  });
});
