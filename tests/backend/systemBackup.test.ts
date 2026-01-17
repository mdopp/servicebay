import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

type ExecCall = { cmd: string; args: string[] };

const mockPaths = {
  dataDir: '',
  systemdDir: '',
  backupDir: ''
};

const execCalls: ExecCall[] = [];
let tempRoot = '';
let nextTarError: Error | null = null;

const listNodesMock = vi.fn(async () => []);
const getConnectionMock = vi.fn();

vi.mock('../../src/lib/dirs', () => ({
  get DATA_DIR() {
    return mockPaths.dataDir;
  },
  get SERVICEBAY_BACKUP_DIR() {
    return mockPaths.backupDir;
  },
  getLocalSystemdDir: () => mockPaths.systemdDir
}));

const loggerWarn = vi.fn();

vi.mock('../../src/lib/logger', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

vi.mock('../../src/lib/nodes', () => ({
  listNodes: () => listNodesMock()
}));

vi.mock('../../src/lib/ssh/pool', () => ({
  SSHConnectionPool: {
    getInstance: () => ({
      getConnection: getConnectionMock
    })
  }
}));

const encodeNodeFolder = (name: string) => Buffer.from(name, 'utf8').toString('base64url');

vi.mock('child_process', () => {
  const execFile = (cmd: string, args: string[], callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
    const argList = Array.isArray(args) ? [...args] : [];
    execCalls.push({ cmd, args: argList });

    const run = async () => {
      if (cmd === 'tar') {
        if (nextTarError) {
          throw nextTarError;
        }
        if (argList[0] === '-czf') {
          const archivePath = argList[1];
          await fs.mkdir(path.dirname(archivePath), { recursive: true });
          await fs.writeFile(archivePath, 'mock-tar');
        } else if (argList[0] === '-xzf') {
          const destIndex = argList.indexOf('-C');
          if (destIndex !== -1) {
            const destDir = argList[destIndex + 1];
            const configDir = path.join(destDir, 'config');
            await fs.mkdir(configDir, { recursive: true });
            await fs.writeFile(path.join(configDir, 'config.json'), '{}');
            await fs.writeFile(path.join(configDir, 'nodes.json'), '[]');
            await fs.writeFile(path.join(configDir, 'checks.json'), '[]');
            const localDir = path.join(destDir, 'nodes', encodeNodeFolder('Local'), 'systemd');
            await fs.mkdir(localDir, { recursive: true });
            await fs.writeFile(path.join(localDir, 'service.kube'), 'apiVersion: quadlet.dev/v1');
          }
        }
      }
    };

    run()
      .then(() => callback(null, '', ''))
      .catch(err => callback(err as NodeJS.ErrnoException, '', ''));
  };

  return {
    execFile,
    default: { execFile }
  };
});

describe('systemBackup', () => {
  beforeEach(async () => {
    vi.resetModules();
    execCalls.length = 0;
    nextTarError = null;
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([]);
    getConnectionMock.mockReset();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-backup-test-'));
    mockPaths.dataDir = path.join(tempRoot, 'data');
    mockPaths.systemdDir = path.join(tempRoot, 'systemd');
    mockPaths.backupDir = path.join(tempRoot, 'backups');
    await fs.mkdir(mockPaths.dataDir, { recursive: true });
    await fs.mkdir(mockPaths.systemdDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates an archive that captures config files and local services', async () => {
    await fs.writeFile(path.join(mockPaths.dataDir, 'config.json'), '{}');
    await fs.writeFile(path.join(mockPaths.dataDir, 'nodes.json'), '[]');
    await fs.writeFile(path.join(mockPaths.dataDir, 'checks.json'), '[]');
    await fs.writeFile(path.join(mockPaths.systemdDir, 'demo.kube'), 'kind: Pod');

    const { createSystemBackup } = await import('../../src/lib/systemBackup');
    const result = await createSystemBackup();

    expect(result.entry.fileName).toMatch(/^servicebay-full-/);
    expect(await fs.stat(path.join(mockPaths.backupDir, result.entry.fileName))).toBeTruthy();
    expect(result.log.some(entry => entry.scope === 'config' && entry.status === 'success')).toBe(true);

    const tarCall = execCalls.find(call => call.cmd === 'tar' && call.args[0] === '-czf');
    expect(tarCall).toBeDefined();
    expect(tarCall?.args).toContain('-C');
  });

  it('restores an archive and triggers systemd reload', async () => {
    const { restoreSystemBackup } = await import('../../src/lib/systemBackup');
    const fileName = 'servicebay-full-test.tar.gz';
    await fs.mkdir(mockPaths.backupDir, { recursive: true });
    await fs.writeFile(path.join(mockPaths.backupDir, fileName), 'existing-archive');

    await restoreSystemBackup(fileName);

    const extractCall = execCalls.find(call => call.cmd === 'tar' && call.args[0] === '-xzf');
    expect(extractCall).toBeDefined();
    const systemctlCall = execCalls.find(call => call.cmd === 'systemctl');
    expect(systemctlCall).toBeDefined();
    await expect(fs.readFile(path.join(mockPaths.dataDir, 'config.json'), 'utf-8')).resolves.toBe('{}');
  });

  it('deletes an archive', async () => {
    const { deleteSystemBackup } = await import('../../src/lib/systemBackup');
    const fileName = 'servicebay-full-old.tar.gz';
    await fs.mkdir(mockPaths.backupDir, { recursive: true });
    await fs.writeFile(path.join(mockPaths.backupDir, fileName), 'old');

    await deleteSystemBackup(fileName);

    await expect(fs.stat(path.join(mockPaths.backupDir, fileName))).rejects.toThrow();
  });

  it('rejects invalid backup names', async () => {
    const { getBackupFileMeta } = await import('../../src/lib/systemBackup');
    await expect(getBackupFileMeta('evil.tar.gz')).rejects.toThrow('Invalid backup name');
  });
});