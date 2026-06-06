import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks -----------------------------------------------------------------
// getConfig / updateConfig are stubbed so we can drive appliedImageDigest and
// assert what the updater persists.
const mockConfig = vi.hoisted(() => ({
  current: { autoUpdate: { enabled: false, schedule: '0 0 * * *' } as Record<string, unknown> },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfig.current),
  updateConfig: vi.fn(async (patch: { autoUpdate: Record<string, unknown> }) => {
    mockConfig.current = { ...mockConfig.current, ...patch };
  }),
}));

// executor.exec / execArgv are stubbed per test.
const mockExec = vi.hoisted(() => ({
  exec: vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: '', stderr: '' })),
  execArgv: vi.fn(async (_argv: string[], _opts?: unknown) => ({ stdout: '', stderr: '' })),
}));
vi.mock('@/lib/executor', () => ({
  getExecutor: () => mockExec,
}));

vi.mock('@/lib/email', () => ({ sendEmailAlert: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkForUpdates, performUpdate, extractImageDigest } from './updater';

// A multi-arch manifest-list document as `podman manifest inspect` returns it.
function manifestList(amd64Digest: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: [
      { platform: { architecture: 'amd64', os: 'linux' }, digest: amd64Digest },
      { platform: { architecture: 'unknown', os: 'unknown' }, digest: 'sha256:ignored' },
    ],
  });
}

const ORIG_FETCH = global.fetch;

function mockReleaseTag(tag: string) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ tag_name: tag, html_url: 'u', published_at: 'd', body: 'notes' }), {
      status: 200,
    }),
  ) as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = { autoUpdate: { enabled: false, schedule: '0 0 * * *' } };
  mockExec.exec.mockResolvedValue({ stdout: '', stderr: '' });
  mockExec.execArgv.mockResolvedValue({ stdout: '', stderr: '' });
  global.fetch = ORIG_FETCH;
  // Pin the running version so semver comparisons are deterministic.
  vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-pkg-path');
});

describe('extractImageDigest', () => {
  it('picks the linux/amd64 entry from a manifest list', () => {
    expect(extractImageDigest(JSON.parse(manifestList('sha256:aaa')))).toBe('sha256:aaa');
  });

  it('falls back to config.digest for a single-arch manifest', () => {
    expect(extractImageDigest({ config: { digest: 'sha256:bbb' } })).toBe('sha256:bbb');
  });

  it('returns null when no usable digest is present', () => {
    expect(extractImageDigest({})).toBeNull();
    expect(extractImageDigest(null)).toBeNull();
    expect(extractImageDigest('garbage')).toBeNull();
  });
});

describe('checkForUpdates — tag/image reconciliation', () => {
  // getCurrentVersion reads package.json from cwd; with cwd pinned to a missing
  // path it returns '0.0.0', so any real release tag is "ahead".

  it('tag ahead AND image newer → update available', async () => {
    mockReleaseTag('4.104.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:OLD';
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:NEW'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
    expect(res.imageBuilding).toBeFalsy();
  });

  it('tag ahead but image digest unchanged → NOT available, building', async () => {
    mockReleaseTag('4.104.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:SAME';
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:SAME'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(false);
    expect(res.imageBuilding).toBe(true);
    expect(res.latest?.version).toBe('4.104.0');
  });

  it('tag ahead but remote digest unknown (registry unreachable) → falls back to tag (available)', async () => {
    mockReleaseTag('4.104.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:OLD';
    mockExec.execArgv.mockRejectedValue(new Error('no registry'));

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
    expect(res.imageBuilding).toBeFalsy();
  });

  it('tag ahead with no applied-digest baseline yet → falls back to tag (available)', async () => {
    mockReleaseTag('4.104.0');
    // no appliedImageDigest
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:NEW'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
  });

  it('tag not ahead seeds the applied digest baseline from the registry', async () => {
    mockReleaseTag('0.0.0'); // equal to the 0.0.0 fallback current → not ahead
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:SEED'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(false);
    expect(res.imageBuilding).toBeFalsy();
    expect(mockConfig.current.autoUpdate.appliedImageDigest).toBe('sha256:SEED');
  });
});

describe('performUpdate — honest pull result', () => {
  it('pull unchanged (image not ready) → reports building, does NOT restart', async () => {
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:SAME';
    mockExec.exec.mockResolvedValue({ stdout: 'up to date', stderr: '' }); // podman pull
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:SAME'), stderr: '' }); // remote digest

    const res = await performUpdate('4.104.0');
    expect(res.success).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.message).toMatch(/still building|latest/i);
    // never issued the systemctl restart
    const restarted = mockExec.exec.mock.calls.some((c) => String(c[0]).includes('systemctl'));
    expect(restarted).toBe(false);
  });

  it('pull advanced the image → persists new digest and restarts', async () => {
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:OLD';
    mockExec.exec.mockResolvedValue({ stdout: 'Pulled new layers', stderr: '' });
    mockExec.execArgv.mockResolvedValue({ stdout: manifestList('sha256:NEW'), stderr: '' });

    const res = await performUpdate('4.104.0');
    expect(res.success).toBe(true);
    expect(res.updated).toBe(true);
    expect(mockConfig.current.autoUpdate.appliedImageDigest).toBe('sha256:NEW');
    const restarted = mockExec.exec.mock.calls.some((c) => String(c[0]).includes('systemctl'));
    expect(restarted).toBe(true);
  });
});
