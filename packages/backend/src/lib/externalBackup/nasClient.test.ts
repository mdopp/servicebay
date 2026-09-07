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
  withNasSession,
  isConnectionLevelError,
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

// #2876 — the FritzBox's FTP server has a small session budget. A connection per
// CALL meant a 13-service run opened 50–70 sessions in ~10 s; after ~8 services it
// answered FIN + ECONNREFUSED and the same tail of services (paperless, beets,
// radicale, jellyfin, syncthing) was never backed up, run after run.
describe('withNasSession — one connection per run (#2876)', () => {
  it('reuses ONE control connection across every operation in the run', async () => {
    await withNasSession(async () => {
      await nasList('sb-backup');
      await nasRemove('sb-backup/old.tar');
      await nasUpload('sb-backup/a.tar', Buffer.from('a'));
      await nasUpload('sb-backup/a.tar.meta.json', Buffer.from('{}'));
      await nasList('sb-backup');
    });
    // Five operations, ONE login — the connect-per-call shape opened five.
    expect(mockClient.access).toHaveBeenCalledTimes(1);
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it('resets the working directory to the login dir before each reused op', async () => {
    await withNasSession(async () => {
      await nasList('sb-backup');
      await nasList('sb-backup');
    });
    // Without the reset the second `cd('sb-backup')` would resolve against
    // sb-backup/ (the first list left the cwd there) and fail.
    expect(mockClient.cd.mock.calls.map(c => c[0])).toEqual(['sb-backup', '/', 'sb-backup']);
  });

  it('still connects per call outside a session (unchanged for probes/one-offs)', async () => {
    await nasList('sb-backup');
    await nasList('sb-backup');
    expect(mockClient.access).toHaveBeenCalledTimes(2);
  });

  it('closes the shared connection even when the run throws', async () => {
    await expect(withNasSession(async () => {
      await nasList('sb-backup');
      throw new Error('run blew up');
    })).rejects.toThrow('run blew up');
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });
});

describe('connection-level backoff + retry (#2876)', () => {
  const refused = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED 192.168.178.1:21'), { code: 'ECONNREFUSED' });

  it('classifies the FritzBox drops as connection-level, and a service fault as not', () => {
    expect(isConnectionLevelError(refused())).toBe(true);
    expect(isConnectionLevelError(new Error('Server sent FIN packet unexpectedly, closing connection.'))).toBe(true);
    expect(isConnectionLevelError('read ECONNRESET (data socket)')).toBe(true);
    // A per-service fault must NOT be retried as if the NAS had dropped us.
    expect(isConnectionLevelError(new Error('EACCES: permission denied, copyfile'))).toBe(false);
    expect(isConnectionLevelError(new Error('452 Insufficient storage space in system'))).toBe(false);
    expect(isConnectionLevelError(undefined)).toBe(false);
  });

  it('backs off and retries service k, and services k+1… still run', async () => {
    vi.useFakeTimers();
    try {
      // The NAS refuses the reconnect twice, then recovers — exactly the shape a
      // tripped session limit has.
      mockClient.access
        .mockRejectedValueOnce(refused())
        .mockRejectedValueOnce(refused());

      const run = withNasSession(async () => {
        await nasUpload('sb-backup/k.tar', Buffer.from('k'));        // service k
        await nasUpload('sb-backup/k-plus-1.tar', Buffer.from('k1')); // service k+1
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      // Two refusals + the successful login. Service k+1 rides the same session.
      expect(mockClient.access).toHaveBeenCalledTimes(3);
      expect(mockClient.uploadFrom).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the last backoff instead of retrying forever', async () => {
    vi.useFakeTimers();
    try {
      mockClient.access.mockRejectedValue(refused());
      const run = withNasSession(() => nasList('sb-backup'));
      const assertion = expect(run).rejects.toThrow(/ECONNREFUSED/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      // 1 initial attempt + 3 backoffs.
      expect(mockClient.access).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry a per-service failure — one attempt, error straight through', async () => {
    mockClient.uploadFrom.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(
      withNasSession(() => nasUpload('sb-backup/x.tar', Buffer.from('x'))),
    ).rejects.toThrow('EACCES');
    expect(mockClient.access).toHaveBeenCalledTimes(1);
  });

  it('throws the dropped connection away so the next operation reconnects', async () => {
    vi.useFakeTimers();
    try {
      mockClient.list.mockRejectedValueOnce(new Error('Server sent FIN packet unexpectedly, closing connection.'));
      const run = withNasSession(() => nasList('sb-backup'));
      await vi.advanceTimersByTimeAsync(30_000);
      await run;
      // The dead client is closed and a fresh session is opened for the retry.
      expect(mockClient.access).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
