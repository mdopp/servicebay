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

// executor.exec / execSafe are stubbed per test.
//
// execSafe now serves two distinct podman calls: `manifest inspect` (registry
// digest) and `inspect servicebay --format {{.ImageDigest}}` (running container
// digest). The default impl routes by argv so a test that only sets the
// registry manifest still gets a sane "running digest" answer; tests that care
// about the running digest set `mockRunningDigest`.
const mockRunningDigest = vi.hoisted(() => ({ value: null as string | null }));
/** `{{.ImageName}}|{{index .Config.Labels "…image.revision"}}` for the running
 *  container — the ground truth for channel + commit (#2708). */
const mockRunningBuild = vi.hoisted(() => ({
  value: 'ghcr.io/mdopp/servicebay:latest|1d3fa8d6c7d60ddc24f8b75ee7b49f5a58796d10',
}));
const mockExec = vi.hoisted(() => ({
  exec: vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: '', stderr: '' })),
  execSafe: vi.fn(async (_argv: string[], _opts?: unknown) => ({ stdout: '', stderr: '' })),
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

// Route execSafe by which podman subcommand it is. `manifestStdout` is the
// `podman manifest inspect` (registry) answer; `mockRunningDigest.value` is the
// running container's digest. Tests that set execSafe via mockResolvedValue
// override this entirely (their value answers BOTH calls — fine where the
// running-digest lookup just needs to not be the registry digest).
function routeExecArgv(manifestStdout: string) {
  mockExec.execSafe.mockImplementation(async (argv: string[]) => {
    if (argv.includes('manifest')) return { stdout: manifestStdout, stderr: '' };
    if (argv.includes('inspect')) {
      // Two distinct `podman inspect servicebay` calls now: the digest lookup
      // and the running-build lookup (#2708). They differ only by --format.
      if (argv.some((a) => a.includes('ImageName'))) {
        return { stdout: mockRunningBuild.value, stderr: '' };
      }
      return { stdout: mockRunningDigest.value ?? '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = { autoUpdate: { enabled: false, schedule: '0 0 * * *' } };
  mockRunningDigest.value = null;
  mockRunningBuild.value = 'ghcr.io/mdopp/servicebay:latest|1d3fa8d6c7d60ddc24f8b75ee7b49f5a58796d10';
  mockExec.exec.mockResolvedValue({ stdout: '', stderr: '' });
  mockExec.execSafe.mockResolvedValue({ stdout: '', stderr: '' });
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
    mockRunningDigest.value = 'sha256:OLD';
    routeExecArgv(manifestList('sha256:NEW'));

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
    expect(res.imageBuilding).toBeFalsy();
  });

  it('tag ahead but image digest unchanged → NOT available, building', async () => {
    mockReleaseTag('4.104.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:SAME';
    mockRunningDigest.value = 'sha256:SAME';
    routeExecArgv(manifestList('sha256:SAME'));

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(false);
    expect(res.imageBuilding).toBe(true);
    expect(res.latest?.version).toBe('4.104.0');
  });

  it('#2062: appliedImageDigest drifted ahead but the running container is OLD → update available, NOT building', async () => {
    // performUpdate once persisted the registry digest while the restart no-op'd
    // and kept the old image, so config now lies: appliedImageDigest == remote.
    // The OLD comparison ('remoteDigest === appliedDigest') would falsely report
    // "still building" forever. Reconciling against the RUNNING container's real
    // digest (which is still the old one) restores the truth: an update IS ready.
    mockReleaseTag('4.137.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:e2476319'; // drifted == remote
    mockRunningDigest.value = 'sha256:61d8725e'; // actually running the old 4.136.0 image
    routeExecArgv(manifestList('sha256:e2476319')); // registry :latest is the new image

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
    expect(res.imageBuilding).toBeFalsy();
  });

  it('tag ahead but remote digest unknown (registry unreachable) → falls back to tag (available)', async () => {
    mockReleaseTag('4.104.0');
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:OLD';
    mockExec.execSafe.mockRejectedValue(new Error('no registry'));

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
    expect(res.imageBuilding).toBeFalsy();
  });

  it('tag ahead with no applied-digest baseline yet → falls back to tag (available)', async () => {
    mockReleaseTag('4.104.0');
    // no appliedImageDigest
    mockExec.execSafe.mockResolvedValue({ stdout: manifestList('sha256:NEW'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(true);
  });

  it('tag not ahead seeds the applied digest baseline from the registry', async () => {
    mockReleaseTag('0.0.0'); // equal to the 0.0.0 fallback current → not ahead
    mockExec.execSafe.mockResolvedValue({ stdout: manifestList('sha256:SEED'), stderr: '' });

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(false);
    expect(res.imageBuilding).toBeFalsy();
    expect(mockConfig.current.autoUpdate.appliedImageDigest).toBe('sha256:SEED');
  });
});

describe('checkForUpdates — running build vs. release (#2708)', () => {
  // The defect: on `:dev` an unreleased commit still carries the LAST release's
  // version (release-please bumps only on the release commit), so the release
  // comparison alone reported "no update" and the UI concluded "you are on the
  // latest version" — every value true, the statement false.

  it('reports the channel + commit of the RUNNING image, not the configured one', async () => {
    mockReleaseTag('0.0.0');
    mockRunningBuild.value = 'ghcr.io/mdopp/servicebay:dev|d01054f5aaaaaaaabbbbbbbbcccccccc22222222';
    routeExecArgv(manifestList('sha256:SEED'));

    const res = await checkForUpdates();
    expect(res.running?.channel).toBe('dev');
    expect(res.running?.revision).toBe('d01054f5aaaaaaaabbbbbbbbcccccccc22222222');
  });

  it('flags a :dev build as unreleased even when the version equals the release', async () => {
    mockReleaseTag('0.0.0'); // equal to the 0.0.0 fallback current → "up to date"
    mockRunningBuild.value = 'ghcr.io/mdopp/servicebay:dev|d01054f5aaaaaaaabbbbbbbbcccccccc22222222';
    routeExecArgv(manifestList('sha256:SEED'));

    const res = await checkForUpdates();
    expect(res.hasUpdate).toBe(false); // the release comparison is unchanged…
    expect(res.unreleasedBuild).toBe(true); // …and no longer the whole story
  });

  it('flags :test the same way', async () => {
    mockReleaseTag('0.0.0');
    mockRunningBuild.value = 'ghcr.io/mdopp/servicebay:test|abc1234abc1234abc1234abc1234abc1234abcd';
    routeExecArgv(manifestList('sha256:SEED'));

    expect((await checkForUpdates()).unreleasedBuild).toBe(true);
  });

  it('leaves a :latest box alone — not an unreleased build', async () => {
    mockReleaseTag('0.0.0');
    routeExecArgv(manifestList('sha256:SEED'));

    const res = await checkForUpdates();
    expect(res.unreleasedBuild).toBe(false);
    expect(res.running?.channel).toBe('latest');
  });

  it('does not invent a commit when the image carries no revision label', async () => {
    mockReleaseTag('0.0.0');
    // Go templates print `<no value>` for a missing map key — not an empty string.
    mockRunningBuild.value = 'ghcr.io/mdopp/servicebay:dev|<no value>';
    routeExecArgv(manifestList('sha256:SEED'));

    const res = await checkForUpdates();
    expect(res.running?.revision).toBeNull();
    expect(res.running?.channel).toBe('dev');
    expect(res.unreleasedBuild).toBe(true);
  });

  it('unknown running build (inspect fails) is not silently treated as a release', async () => {
    mockReleaseTag('0.0.0');
    mockExec.execSafe.mockRejectedValue(new Error('no podman'));

    const res = await checkForUpdates();
    expect(res.running?.channel).toBeNull();
    expect(res.running?.revision).toBeNull();
    // Unknown is unknown: we don't claim "unreleased", and we don't claim the
    // opposite either — the card just falls back to the release comparison.
    expect(res.unreleasedBuild).toBe(false);
  });
});

describe('performUpdate — honest pull result', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('pull unchanged (image not ready) → reports building, does NOT recreate/restart', async () => {
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:SAME';
    mockExec.exec.mockResolvedValue({ stdout: 'up to date', stderr: '' }); // podman pull
    mockExec.execSafe.mockResolvedValue({ stdout: manifestList('sha256:SAME'), stderr: '' }); // remote digest

    const res = await performUpdate('4.104.0');
    await flush();
    expect(res.success).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.message).toMatch(/still building|latest/i);
    // never issued the recreate or the systemctl restart
    // #2737: the recreate/restart argv rides execSafe; exec is the shell tier.
    const line = (c: unknown[]) => (Array.isArray(c[0]) ? c[0].join(' ') : String(c[0]));
    const issued = [...mockExec.exec.mock.calls, ...mockExec.execSafe.mock.calls].map(line);
    const recreated = issued.some((c) => c.includes('rm -f servicebay'));
    const restarted = issued.some((c) => c.includes('systemctl'));
    expect(recreated).toBe(false);
    expect(restarted).toBe(false);
  });

  it('pull advanced the image → persists new digest, recreates (rm -f) and restarts (#2063)', async () => {
    mockConfig.current.autoUpdate.appliedImageDigest = 'sha256:OLD';
    mockExec.exec.mockResolvedValue({ stdout: 'Pulled new layers', stderr: '' });
    mockExec.execSafe.mockResolvedValue({ stdout: manifestList('sha256:NEW'), stderr: '' });

    const res = await performUpdate('4.104.0');
    await flush(); // let the detached recreate/restart run
    expect(res.success).toBe(true);
    expect(res.updated).toBe(true);
    expect(mockConfig.current.autoUpdate.appliedImageDigest).toBe('sha256:NEW');
    // #2104: stamp the moment of the applied update so Home can show "Last updated".
    expect(typeof mockConfig.current.autoUpdate.appliedImageUpdatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(mockConfig.current.autoUpdate.appliedImageUpdatedAt as string))).toBe(false);
    // #2063: a plain restart keeps the old container — recreate with rm -f first.
    // #2737: the recreate/restart argv rides execSafe; exec is the shell tier.
    const line = (c: unknown[]) => (Array.isArray(c[0]) ? c[0].join(' ') : String(c[0]));
    const issued = [...mockExec.exec.mock.calls, ...mockExec.execSafe.mock.calls].map(line);
    const recreated = issued.some((c) => c.includes('rm -f servicebay'));
    const restarted = issued.some((c) => c.includes('systemctl'));
    expect(recreated).toBe(true);
    expect(restarted).toBe(true);
  });
});
