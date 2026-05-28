import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient, mockGetConfig } = vi.hoisted(() => ({
  mockClient: {
    access: vi.fn(),
    pwd: vi.fn(),
    ensureDir: vi.fn(),
    uploadFrom: vi.fn(),
    downloadTo: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
    close: vi.fn(),
  },
  mockGetConfig: vi.fn(),
}));

vi.mock('basic-ftp', () => ({ Client: vi.fn(function () { return mockClient; }) }));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));

import { getNasTarget, testNasConnection, nasUpload, nasDownload, nasList, nasRemove } from './nasClient';

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
  it('lists a directory', async () => {
    expect(await nasList('sb-backup')).toEqual([{ name: 'x.tar', size: 10 }]);
    expect(mockClient.list).toHaveBeenCalledWith('sb-backup');
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
