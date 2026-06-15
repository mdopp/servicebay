import { describe, it, expect, vi, beforeEach } from 'vitest';

// executor.execArgv is stubbed per test so we can drive the podman inspect /
// manifest inspect stdout. Keyed on the podman subcommand (inspect vs manifest).
const mockExec = vi.hoisted(() => ({
  execArgv: vi.fn(async (_argv: string[], _opts?: unknown) => ({ stdout: '', stderr: '' })),
}));
vi.mock('@/lib/executor', () => ({
  getExecutor: () => mockExec,
}));

const mockConfig = vi.hoisted(() => ({
  current: { installedTemplates: {} as Record<string, unknown> },
}));
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfig.current),
}));

const mockRegistry = vi.hoisted(() => ({ yaml: null as string | null }));
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: vi.fn(async () => mockRegistry.yaml),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isUpdateAvailable,
  getRegistryImageDigest,
  getRunningImageDigest,
  getServiceImageUpdate,
  getInstalledImageUpdates,
} from './imageDigest';

// A multi-arch manifest-list document (registry side, `podman manifest inspect`).
function manifestList(amd64Digest: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: [
      { platform: { architecture: 'amd64', os: 'linux' }, digest: amd64Digest },
      { platform: { architecture: 'arm64', os: 'linux' }, digest: 'sha256:other' },
    ],
  });
}

// A single-image inspect document (running side, `podman inspect`) — array form.
function inspectDoc(digest: string): string {
  return JSON.stringify([{ Id: 'abc', Digest: digest, RepoTags: ['x:latest'] }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.execArgv.mockResolvedValue({ stdout: '', stderr: '' });
  mockConfig.current = { installedTemplates: {} };
  mockRegistry.yaml = null;
});

describe('isUpdateAvailable (digest comparison)', () => {
  it('running == registry → false', () => {
    expect(isUpdateAvailable('sha256:aaa', 'sha256:aaa')).toBe(false);
  });

  it('running != registry → true', () => {
    expect(isUpdateAvailable('sha256:aaa', 'sha256:bbb')).toBe(true);
  });

  it('missing running digest → false (unknown, never crash)', () => {
    expect(isUpdateAvailable(null, 'sha256:bbb')).toBe(false);
    expect(isUpdateAvailable(undefined, 'sha256:bbb')).toBe(false);
  });

  it('missing registry digest → false (unknown, never crash)', () => {
    expect(isUpdateAvailable('sha256:aaa', null)).toBe(false);
    expect(isUpdateAvailable('sha256:aaa', undefined)).toBe(false);
  });

  it('both unknown → false', () => {
    expect(isUpdateAvailable(null, null)).toBe(false);
  });
});

describe('getRegistryImageDigest', () => {
  it('extracts the linux/amd64 digest from a manifest list', async () => {
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:reg'), stderr: '' });
    await expect(getRegistryImageDigest('ghcr.io/x:1')).resolves.toBe('sha256:reg');
  });

  it('returns null when podman errors (treat as unknown)', async () => {
    mockExec.execArgv.mockRejectedValue(new Error('registry unreachable'));
    await expect(getRegistryImageDigest('ghcr.io/x:1')).resolves.toBeNull();
  });

  it('returns null on unparseable stdout', async () => {
    mockExec.execArgv.mockResolvedValue({ stdout: 'not json', stderr: '' });
    await expect(getRegistryImageDigest('ghcr.io/x:1')).resolves.toBeNull();
  });
});

describe('getRunningImageDigest', () => {
  it('extracts the digest from a podman inspect array document', async () => {
    mockExec.execArgv.mockResolvedValue({ stdout: inspectDoc('sha256:run'), stderr: '' });
    await expect(getRunningImageDigest('ghcr.io/x:1')).resolves.toBe('sha256:run');
  });

  it('returns null when the image is not present (podman error)', async () => {
    mockExec.execArgv.mockRejectedValue(new Error('no such object'));
    await expect(getRunningImageDigest('ghcr.io/x:1')).resolves.toBeNull();
  });
});

describe('getServiceImageUpdate', () => {
  it('reports updateAvailable=true when running differs from registry', async () => {
    mockExec.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv.includes('manifest')) return { stdout: manifestList('sha256:reg'), stderr: '' };
      return { stdout: inspectDoc('sha256:run'), stderr: '' };
    });
    const r = await getServiceImageUpdate('immich', 'ghcr.io/x:1');
    expect(r).toEqual({
      service: 'immich',
      image: 'ghcr.io/x:1',
      runningDigest: 'sha256:run',
      registryDigest: 'sha256:reg',
      updateAvailable: true,
    });
  });

  it('reports updateAvailable=false when digests match', async () => {
    mockExec.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv.includes('manifest')) return { stdout: manifestList('sha256:same'), stderr: '' };
      return { stdout: inspectDoc('sha256:same'), stderr: '' };
    });
    const r = await getServiceImageUpdate('immich', 'ghcr.io/x:1');
    expect(r.updateAvailable).toBe(false);
  });

  it('does not crash and reports false when both lookups fail', async () => {
    mockExec.execArgv.mockRejectedValue(new Error('podman gone'));
    const r = await getServiceImageUpdate('immich', 'ghcr.io/x:1');
    expect(r).toEqual({
      service: 'immich',
      image: 'ghcr.io/x:1',
      runningDigest: null,
      registryDigest: null,
      updateAvailable: false,
    });
  });
});

describe('getInstalledImageUpdates (fan-out)', () => {
  it('skips invalid template names and yields one entry per declared image', async () => {
    mockConfig.current = {
      installedTemplates: { immich: { schemaVersion: 1 }, 'Bad Name': { schemaVersion: 1 } },
    };
    mockRegistry.yaml = 'spec:\n  containers:\n  - image: ghcr.io/x:1\n    name: x\n';
    mockExec.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv.includes('manifest')) return { stdout: manifestList('sha256:reg'), stderr: '' };
      return { stdout: inspectDoc('sha256:run'), stderr: '' };
    });
    const out = await getInstalledImageUpdates();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ service: 'immich', image: 'ghcr.io/x:1', updateAvailable: true });
  });

  it('returns empty when nothing is installed', async () => {
    mockConfig.current = { installedTemplates: {} };
    await expect(getInstalledImageUpdates()).resolves.toEqual([]);
  });
});
