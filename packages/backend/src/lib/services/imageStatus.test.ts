/**
 * #2995 — the whole value of this module is that it does NOT collapse every
 * registry failure into one answer.
 *
 * `podmanDigest.ts` returns `null` for all of them, which is right for its
 * callers (an unknown digest is never "unchanged") and useless for an agent:
 * "the registry has no such tag" means your build never landed, while "could
 * not reach the registry" means retry. A session that cannot tell those apart
 * is the session that spent 2026-09-20 smuggling a build into a container.
 *
 * So the classifier and the summary line get real coverage against the strings
 * podman actually emits, and the report's `ok`/`upToDate` are pinned never to
 * guess from a missing digest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSafe: vi.fn(),
  getRunningImageDigest: vi.fn(),
  getServiceFiles: vi.fn(),
}));

vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ execSafe: mocks.execSafe }) }));
vi.mock('@/lib/podmanDigest', () => ({ getRunningImageDigest: mocks.getRunningImageDigest }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./serviceListing', () => ({
  ServiceListing: { getServiceFiles: mocks.getServiceFiles },
}));

import { classifyRegistryError, summarise, getServiceImageStatus } from './imageStatus';

const manifest = (digest: string) => JSON.stringify({
  mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
  manifests: [{ digest, platform: { architecture: 'amd64', os: 'linux' } }],
});

describe('classifyRegistryError — each kind of "no" is a different next move', () => {
  it.each([
    ['manifest unknown', 'not-published'],
    ['Error: ghcr.io/mdopp/asteroids:latest: manifest unknown', 'not-published'],
    ['name unknown: repository name not known to registry', 'not-published'],
    ['reference does not exist', 'not-published'],
    ['unauthorized: authentication required', 'unauthorized'],
    ['Error: denied: requested access to the resource is denied', 'unauthorized'],
    ['dial tcp: lookup ghcr.io: no such host', 'unreachable'],
    ['Get "https://ghcr.io/v2/": net/http: TLS handshake timeout', 'unreachable'],
    ['connection refused', 'unreachable'],
    ['something nobody has seen before', 'unknown'],
  ])('%s → %s', (message, expected) => {
    expect(classifyRegistryError(message).problem).toBe(expected);
  });

  it('checks auth and reachability BEFORE the not-found shapes', () => {
    // "denied: ... not found" really happens on a private package: a registry
    // that hides existence behind auth. Reading it as `not-published` would
    // send someone to fix a build that is perfectly fine.
    expect(classifyRegistryError('denied: requested access to the resource is not found').problem)
      .toBe('unauthorized');
    // And a timeout mentioning the tag must not read as "no such tag".
    expect(classifyRegistryError('i/o timeout while resolving manifest unknown host').problem)
      .toBe('unreachable');
  });

  it('clips and flattens the registry\'s own words rather than dropping them', () => {
    const { detail } = classifyRegistryError(`unauthorized\n   ${'x'.repeat(600)}`);
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail).not.toContain('\n');
    expect(detail.startsWith('unauthorized')).toBe(true);
  });
});

describe('summarise names a next move, not a status word', () => {
  const img = (over: Partial<Record<string, unknown>> = {}) => ({
    image: 'ghcr.io/mdopp/asteroids:latest',
    registry: 'sha256:aaa', local: 'sha256:aaa',
    published: true, pulled: true, upToDate: true, problem: null,
    ...over,
  } as Parameters<typeof summarise>[1][number]);

  it('an unpublished image says the build never landed', () => {
    const s = summarise('asteroids', [img({ published: false, problem: 'not-published', registry: null })]);
    expect(s).toContain('no such tag');
    expect(s).toContain('checkout');
  });

  it('a refused registry is not reported as a missing build', () => {
    const s = summarise('asteroids', [img({ published: false, problem: 'unauthorized', registry: null })]);
    expect(s).toContain('refused');
    expect(s).not.toContain('never published');
  });

  it('an unreachable registry says explicitly that it proves nothing', () => {
    const s = summarise('asteroids', [img({ published: false, problem: 'unreachable', registry: null })]);
    expect(s).toContain('says nothing about whether the image exists');
    expect(s).toContain('Retry');
  });

  it('a registry that ANSWERED unreadably is not called unreachable (#3036)', () => {
    // Measured on the box: the summary said "Could not reach the registry"
    // while the registry had answered and only its manifest was unreadable.
    // A reader told it is unreachable retries; the thing to do is look at what
    // was served.
    const s = summarise('asteroids', [img({ published: false, problem: 'unknown', registry: null })]);
    expect(s).toContain('The registry answered');
    expect(s).not.toContain('Could not reach');
    expect(s).toContain('unknown, NOT no');
    expect(s).toContain('podman manifest inspect');
  });

  it('a behind image points at the verb that moves it', () => {
    const s = summarise('asteroids', [img({ local: 'sha256:old', upToDate: false })]);
    expect(s).toContain('servicebay update asteroids');
  });

  it('a service declaring no image says so instead of claiming health', () => {
    const s = summarise('asteroids', []);
    expect(s).toContain('no image reference');
  });
});

describe('getServiceImageStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServiceFiles.mockResolvedValue({ quadletKind: 'container', kubeContent: 'Image=ghcr.io/mdopp/asteroids:latest\n' });
  });

  it('reports a published, pulled, current image and exits the happy path', async () => {
    mocks.execSafe.mockResolvedValue({ stdout: manifest('sha256:abc') });
    mocks.getRunningImageDigest.mockResolvedValue('sha256:abc');
    const r = await getServiceImageStatus('Local', 'asteroids');
    expect(r.ok).toBe(true);
    expect(r.images[0]).toMatchObject({ published: true, pulled: true, upToDate: true, problem: null });
  });

  it('reports an unpublished image as not ok, with the reason and the registry\'s words', async () => {
    mocks.execSafe.mockRejectedValue(new Error('Error: ghcr.io/mdopp/asteroids:latest: manifest unknown'));
    mocks.getRunningImageDigest.mockResolvedValue(null);
    const r = await getServiceImageStatus('Local', 'asteroids');
    expect(r.ok).toBe(false);
    expect(r.images[0]).toMatchObject({ published: false, pulled: false, problem: 'not-published' });
    expect(r.images[0].detail).toContain('manifest unknown');
    expect(r.summary).toContain('no such tag');
  });

  it('never guesses upToDate from a digest it does not have', async () => {
    // The rule podmanDigest.ts states and this must not break: an unknown
    // digest is unknown, never "unchanged".
    mocks.execSafe.mockResolvedValue({ stdout: manifest('sha256:abc') });
    mocks.getRunningImageDigest.mockResolvedValue(null);
    const r = await getServiceImageStatus('Local', 'asteroids');
    expect(r.images[0].upToDate).toBeNull();
    expect(r.images[0].pulled).toBe(false);
  });

  it('a service with no image reference is not "ok" — there is nothing to be ok about', async () => {
    mocks.getServiceFiles.mockResolvedValue({ quadletKind: 'container', kubeContent: '[Unit]\n' });
    const r = await getServiceImageStatus('Local', 'asteroids');
    expect(r.images).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('no image reference');
  });

  it('inspects the manifest only — it pulls nothing', async () => {
    mocks.execSafe.mockResolvedValue({ stdout: manifest('sha256:abc') });
    mocks.getRunningImageDigest.mockResolvedValue('sha256:abc');
    await getServiceImageStatus('Local', 'asteroids');
    for (const [argv] of mocks.execSafe.mock.calls) {
      expect(argv).toEqual(['podman', 'manifest', 'inspect', 'ghcr.io/mdopp/asteroids:latest']);
    }
  });

  it('a registry that answers with an unreadable manifest is "unknown", not "not-published"', async () => {
    mocks.execSafe.mockResolvedValue({ stdout: JSON.stringify({ nothing: true }) });
    mocks.getRunningImageDigest.mockResolvedValue(null);
    const r = await getServiceImageStatus('Local', 'asteroids');
    expect(r.images[0].problem).toBe('unknown');
    expect(r.images[0].detail).toContain('no digest could be read');
  });
});
