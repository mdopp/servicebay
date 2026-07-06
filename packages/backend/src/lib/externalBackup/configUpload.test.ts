import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { mockBackup } = vi.hoisted(() => ({ mockBackup: vi.fn() }));
vi.mock('./producer', () => ({ backupServiceToNas: mockBackup }));

import {
  parseUploadArgs,
  looksLikeServiceLayout,
  runConfigUpload,
  ConfigUploadError,
  type UploadIO,
} from './configUpload';
import { getServiceManifest } from './serviceManifest';

let tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'configupload-test-'));
  tmpDirs.push(dir);
  return dir;
}
async function writeFile(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

function fakeIO(answers: boolean[] = []): UploadIO & { logs: string[]; questions: string[] } {
  const logs: string[] = [];
  const questions: string[] = [];
  return {
    logs,
    questions,
    log: m => logs.push(m),
    confirm: async q => {
      questions.push(q);
      return answers.shift() ?? false;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBackup.mockResolvedValue({
    service: 'adguard',
    tarName: 'adguard.tar',
    metaName: 'adguard.tar.meta.json',
    size: 1234,
    meta: { service: 'adguard', schemaVersion: 1, createdAt: 'now', nodeId: 'box' },
  });
});

afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe('parseUploadArgs', () => {
  it('parses required + optional flags with a default target', () => {
    expect(parseUploadArgs(['--service', 'adguard', '--from', '/x'])).toEqual({
      service: 'adguard',
      from: '/x',
      target: 'fritzbox',
      assumeYes: false,
    });
  });

  it('honors --target, --yes and the -y/-h short forms', () => {
    expect(parseUploadArgs(['--service', 's', '--from', '/x', '--target', 't', '-y'])).toEqual({
      service: 's',
      from: '/x',
      target: 't',
      assumeYes: true,
    });
    expect(parseUploadArgs(['-h'])).toEqual({ help: true });
  });

  it('rejects missing required flags, missing values, and unknown args', () => {
    expect(() => parseUploadArgs(['--from', '/x'])).toThrow(/--service is required/);
    expect(() => parseUploadArgs(['--service', 's'])).toThrow(/--from is required/);
    expect(() => parseUploadArgs(['--service'])).toThrow(/Missing value for --service/);
    expect(() => parseUploadArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('looksLikeServiceLayout', () => {
  it('is true when at least one include path is present', async () => {
    const dir = await mkTmp();
    await writeFile(dir, 'conf/AdGuardHome.yaml', 'x');
    expect(await looksLikeServiceLayout(dir, getServiceManifest('adguard')!)).toBe(true);
  });

  it('is false for an empty/unrelated directory', async () => {
    const dir = await mkTmp();
    await writeFile(dir, 'random.txt', 'x');
    expect(await looksLikeServiceLayout(dir, getServiceManifest('adguard')!)).toBe(false);
  });
});

describe('runConfigUpload', () => {
  it('uploads a recognized layout without prompting', async () => {
    const dir = await mkTmp();
    await writeFile(dir, 'conf/AdGuardHome.yaml', 'x');
    const io = fakeIO();
    const result = await runConfigUpload({ service: 'adguard', from: dir, target: 'fritzbox', assumeYes: false }, io);
    expect(result.tarName).toBe('adguard.tar');
    expect(io.questions).toEqual([]);
    expect(mockBackup).toHaveBeenCalledWith('adguard', { serviceDataDir: dir });
  });

  it('prompts and aborts on an unrecognized layout when the operator declines', async () => {
    const dir = await mkTmp();
    await writeFile(dir, 'random.txt', 'x');
    const io = fakeIO([false]);
    await expect(
      runConfigUpload({ service: 'adguard', from: dir, target: 'fritzbox', assumeYes: false }, io),
    ).rejects.toThrow(/Aborted/);
    expect(io.questions).toHaveLength(1);
    expect(mockBackup).not.toHaveBeenCalled();
  });

  it('uploads an unrecognized layout when the operator confirms', async () => {
    const dir = await mkTmp();
    await writeFile(dir, 'random.txt', 'x');
    const io = fakeIO([true]);
    await runConfigUpload({ service: 'adguard', from: dir, target: 'fritzbox', assumeYes: false }, io);
    expect(mockBackup).toHaveBeenCalledWith('adguard', { serviceDataDir: dir });
  });

  it('skips the prompt entirely with --yes even on an unrecognized layout', async () => {
    const dir = await mkTmp();
    const io = fakeIO();
    await runConfigUpload({ service: 'adguard', from: dir, target: 'fritzbox', assumeYes: true }, io);
    expect(io.questions).toEqual([]);
    expect(mockBackup).toHaveBeenCalled();
  });

  it('rejects an unknown service before touching the filesystem', async () => {
    const io = fakeIO();
    await expect(
      runConfigUpload({ service: 'not-a-real-service', from: '/x', target: 'fritzbox', assumeYes: true }, io),
    ).rejects.toThrow(ConfigUploadError);
    expect(mockBackup).not.toHaveBeenCalled();
  });

  it('rejects an unsupported target', async () => {
    const dir = await mkTmp();
    await expect(
      runConfigUpload({ service: 'adguard', from: dir, target: 's3', assumeYes: true }, fakeIO()),
    ).rejects.toThrow(/Unsupported --target/);
  });

  it('rejects a --from that is not a directory', async () => {
    await expect(
      runConfigUpload({ service: 'adguard', from: '/no/such/dir', target: 'fritzbox', assumeYes: true }, fakeIO()),
    ).rejects.toThrow(/not a directory/);
  });
});
