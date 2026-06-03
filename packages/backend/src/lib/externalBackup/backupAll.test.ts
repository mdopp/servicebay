import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockCfg } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);
// The box backup routes through the host agent (#1597). In-process, wire the
// executor straight to the local fs so the same staging/tar logic runs against
// the test's real temp dir (and exercises the agent-backend code path).
const stageDirs: string[] = [];
vi.mock('../executor', () => ({
  getExecutor: () => ({
    async execArgv(argv: string[]) {
      const [cmd, ...args] = argv;
      if (cmd === 'find') {
        const ents = await fs.readdir(args[0], { withFileTypes: true }).catch(() => []);
        return {
          stdout: ents.map(e => `${e.isDirectory() ? 'd' : e.isFile() ? 'f' : 'o'}\t${e.name}`).join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'test' && args[0] === '-d') {
        if (!(await fs.stat(args[1]).then(s => s.isDirectory(), () => false))) throw new Error('not a dir');
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'test' && args[0] === '-e') {
        if (!(await fs.access(args[1]).then(() => true, () => false))) throw new Error('missing');
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'mkdir') { await fs.mkdir(args[1], { recursive: true }); return { stdout: '', stderr: '' }; }
      if (cmd === 'cp') { await fs.copyFile(args[args.length - 2], args[args.length - 1]); return { stdout: '', stderr: '' }; }
      if (cmd === 'mktemp') {
        const d = await fs.mkdtemp(path.join(os.tmpdir(), 'backupall-stage-'));
        stageDirs.push(d);
        return { stdout: d, stderr: '' };
      }
      if (cmd === 'tar') {
        await execFileAsync('tar', ['-cf', args[1], '-C', args[3], '.']);
        stageDirs.push(args[1]);
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'base64') {
        return { stdout: (await fs.readFile(args[0])).toString('base64'), stderr: '' };
      }
      if (cmd === 'rm') return { stdout: '', stderr: '' };
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    },
    exists: (p: string) => fs.access(p).then(() => true, () => false),
    readFile: (p: string) => fs.readFile(p, 'utf8'),
    writeFile: (p: string, c: string) => fs.writeFile(p, c),
  }),
}));

import { backupInstalledServicesToNas } from './producer';

let tmpRoot: string;

async function write(rel: string, content: string) {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockNas.nasUpload.mockResolvedValue(undefined);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'backupall-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await Promise.all(stageDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

describe('backupInstalledServicesToNas', () => {
  it('backs up only installed manifest services, skipping the rest', async () => {
    // adguard is installed (with a manifest config file); home-assistant is NOT.
    await write('adguard/conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    mockCfg.getConfig.mockResolvedValue({
      templateSettings: { DATA_DIR: tmpRoot },
      installedTemplates: { adguard: { schemaVersion: 1, installedAt: 'x' } },
    });

    const results = await backupInstalledServicesToNas();

    // Only adguard ran; home-assistant/authelia/etc. are not installed → not attempted.
    expect(results.map(r => r.service)).toEqual(['adguard']);
    expect(results[0]).toMatchObject({ service: 'adguard', ok: true, tarName: 'adguard.tar' });
    // The tar + meta were uploaded to the NAS.
    const uploaded = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploaded).toContain('sb-backup/adguard.tar');
  });

  it('captures a per-service failure without aborting the run', async () => {
    // adguard installed but its data dir is missing its config → produces no
    // files → backupServiceToNas throws; the run records it as ok:false.
    mockCfg.getConfig.mockResolvedValue({
      templateSettings: { DATA_DIR: tmpRoot },
      installedTemplates: { adguard: { schemaVersion: 1, installedAt: 'x' } },
    });

    const results = await backupInstalledServicesToNas();
    expect(results).toHaveLength(1);
    expect(results[0].service).toBe('adguard');
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBeTruthy();
  });

  it('returns empty when nothing with a manifest is installed', async () => {
    mockCfg.getConfig.mockResolvedValue({ installedTemplates: { 'some-unmanaged-thing': {} } });
    expect(await backupInstalledServicesToNas()).toEqual([]);
  });
});
