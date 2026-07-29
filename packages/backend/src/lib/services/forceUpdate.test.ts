/**
 * Force-update action (#2397).
 *
 * The acceptance is behavioural, so these tests drive the real orchestrator
 * against a fake node: `execArgv` records every podman/systemctl argv, and the
 * digest reads are keyed off the recorded pull so "did the image actually
 * advance" is exercised end-to-end rather than asserted on a mock's return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExec = vi.hoisted(() => ({
  calls: [] as string[][],
  execArgv: vi.fn(async (_argv: string[], _opts?: unknown) => ({ stdout: '', stderr: '' })),
  fail: new Set<string>(),
}));
vi.mock('@/lib/executor', () => ({ getExecutor: () => mockExec }));

const mockDigest = vi.hoisted(() => ({
  local: new Map<string, string | null>(),
  registry: new Map<string, string | null>(),
  /** image → digest the local store advances to once `podman pull` has run. */
  pullLands: new Map<string, string>(),
}));
vi.mock('@/lib/podmanDigest', () => ({
  getRunningImageDigest: vi.fn(async (image: string) => mockDigest.local.get(image) ?? null),
  getRegistryImageDigest: vi.fn(async (image: string) => mockDigest.registry.get(image) ?? null),
}));

const mockTwin = vi.hoisted(() => ({ containers: [] as unknown[] }));
vi.mock('@/lib/store/repository', () => ({ getContainers: () => mockTwin.containers }));

const mockListing = vi.hoisted(() => ({
  files: {} as Record<string, unknown>,
  status: 'Active: activating',
}));
vi.mock('./serviceListing', () => ({
  ServiceListing: {
    getServiceFiles: vi.fn(async () => mockListing.files),
    getServiceStatus: vi.fn(async () => mockListing.status),
  },
}));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { logger } from '@/lib/logger';
import { forceUpdateService, collectServiceImages } from './forceUpdate';

const POD_SPEC = `
apiVersion: v1
kind: Pod
metadata:
  name: media
spec:
  containers:
    - name: jellyfin
      image: docker.io/jellyfin/jellyfin:latest
`;

const CONTAINER_UNIT = `[Unit]
Description=ollama
[Container]
Image=docker.io/ollama/ollama:latest
ContainerName=ollama
[Install]
WantedBy=default.target
`;

/** argv join, for readable assertions on what ran on the node. */
const ran = () => mockExec.calls.map((c) => c.join(' '));

function container(over: Record<string, unknown> = {}) {
  return {
    id: 'c1', names: ['media-jellyfin'], image: 'docker.io/jellyfin/jellyfin:latest',
    labels: { PODMAN_SYSTEMD_UNIT: 'media.service' }, ports: [], mounts: [], networks: [],
    state: 'running', status: 'Up', created: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.calls = [];
  mockExec.fail = new Set();
  mockExec.execArgv.mockImplementation(async (argv: string[]) => {
    mockExec.calls.push(argv);
    const key = argv.slice(0, 3).join(' ');
    if ([...mockExec.fail].some((f) => argv.join(' ').includes(f))) {
      throw new Error(`command failed: ${key}`);
    }
    // A successful `podman pull` is what advances the local store.
    if (argv[0] === 'podman' && argv[1] === 'pull') {
      const landed = mockDigest.pullLands.get(argv[2]);
      if (landed) mockDigest.local.set(argv[2], landed);
    }
    if (argv[0] === 'podman' && argv[1] === 'rmi') mockDigest.local.delete(argv[3]);
    return { stdout: '', stderr: '' };
  });
  mockDigest.local = new Map();
  mockDigest.registry = new Map();
  mockDigest.pullLands = new Map();
  mockTwin.containers = [container()];
  mockListing.files = { quadletKind: 'kube', kubeContent: '[Kube]\nYaml=media.yml', yamlContent: POD_SPEC };
  mockListing.status = 'Active: activating';
});

describe('collectServiceImages (#2397)', () => {
  it('reads the images out of a .kube service pod spec', () => {
    expect(collectServiceImages({ quadletKind: 'kube', yamlContent: POD_SPEC }))
      .toEqual(['docker.io/jellyfin/jellyfin:latest']);
  });

  it('reads the Image= directive of a single-container .container Quadlet', () => {
    // The ollama shape the issue named — no pod spec exists at all, so a
    // pod-spec-only reader would have found nothing to pull.
    expect(collectServiceImages({ quadletKind: 'container', kubeContent: CONTAINER_UNIT }))
      .toEqual(['docker.io/ollama/ollama:latest']);
  });

  it('dedupes and survives an unparseable pod spec without throwing', () => {
    const dup = `spec:\n  initContainers:\n    - image: a:1\n  containers:\n    - image: a:1\n    - image: b:2\n`;
    expect(collectServiceImages({ quadletKind: 'kube', yamlContent: dup })).toEqual(['a:1', 'b:2']);
    expect(collectServiceImages({ quadletKind: 'kube', yamlContent: '{{{ not yaml' })).toEqual([]);
  });
});

describe('forceUpdateService (#2397 criterion 1: an operator can force-update a service)', () => {
  it('pulls, then recreates the containers, and reports the image that advanced', async () => {
    const image = 'docker.io/jellyfin/jellyfin:latest';
    mockDigest.local.set(image, 'sha256:old');
    mockDigest.registry.set(image, 'sha256:new');
    mockDigest.pullLands.set(image, 'sha256:new');

    const result = await forceUpdateService('Local', 'media');

    expect(result.changed).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.images[0]).toMatchObject({
      image, before: 'sha256:old', registry: 'sha256:new', after: 'sha256:new',
      pulled: true, changed: true, stale: false,
    });
    // The pull runs BEFORE the stop (service stays up during the download) and
    // the container is force-removed so the unit cannot restart onto the cached
    // image (#2063 — a plain `systemctl restart` reuses the old container).
    expect(ran()).toEqual([
      `podman pull ${image}`,
      'systemctl --user stop media.service',
      'podman rm -f --ignore media-jellyfin',
      'systemctl --user --no-block start media.service',
    ]);
    expect(result.recreated).toEqual(['media-jellyfin']);
  });

  it('works independently of podman-auto-update — it never consults the timer', async () => {
    // The acceptance says "independent of podman-auto-update's timer state"
    // (#2396 left the timer masked on a default box). Structural proof: no
    // command in the whole action touches the timer or `podman auto-update`.
    await forceUpdateService('Local', 'media');
    expect(ran().join('\n')).not.toMatch(/auto-update|podman-auto-update|\.timer/);
  });

  it('accepts a .container service and pulls its Image= directive', async () => {
    mockListing.files = { quadletKind: 'container', kubeContent: CONTAINER_UNIT, yamlContent: '' };
    mockTwin.containers = [container({ names: ['ollama'], image: 'docker.io/ollama/ollama:latest', labels: { PODMAN_SYSTEMD_UNIT: 'ollama.service' } })];
    const result = await forceUpdateService('Local', 'ollama');
    expect(result.images.map((i) => i.image)).toEqual(['docker.io/ollama/ollama:latest']);
    expect(ran()).toContain('podman rm -f --ignore ollama');
  });

  it('reports an unchanged image as unchanged instead of a cheerful success', async () => {
    const image = 'docker.io/jellyfin/jellyfin:latest';
    mockDigest.local.set(image, 'sha256:same');
    mockDigest.registry.set(image, 'sha256:same');
    const result = await forceUpdateService('Local', 'media');
    expect(result.changed).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.images[0]).toMatchObject({ pulled: true, changed: false, stale: false });
  });

  it('treats an unreadable digest as unknown, never as unchanged or stale', async () => {
    // Registry unreachable / image not pulled yet: both flags must stay false —
    // we may not claim an update, and may not claim the image is stuck either.
    const result = await forceUpdateService('Local', 'media');
    expect(result.images[0]).toMatchObject({ before: null, registry: null, after: null, changed: false, stale: false });
  });

  it('surfaces a failed pull instead of swallowing it, and does not claim a change', async () => {
    mockExec.fail.add('podman pull');
    const result = await forceUpdateService('Local', 'media');
    expect(result.images[0].pulled).toBe(false);
    expect(result.images[0].error).toContain('failed');
    expect(result.changed).toBe(false);
    // The recreate still runs — the unit must not be left stopped.
    expect(ran()).toContain('systemctl --user --no-block start media.service');
  });

  it('is an honest no-op when the definition declares no image', async () => {
    mockListing.files = { quadletKind: 'kube', kubeContent: '[Kube]', yamlContent: 'kind: Pod\n' };
    const result = await forceUpdateService('Local', 'media');
    expect(result.images).toEqual([]);
    // No fake activity: nothing is stopped or started to look busy.
    expect(ran()).toEqual([]);
    expect(result.logs.join('\n')).toContain('No image reference');
  });
});

describe('forceUpdateService (#2397 criterion 2: a stuck image is refreshed via the fallback)', () => {
  const image = 'docker.io/jellyfin/jellyfin:latest';

  it('flags a stuck image as stale when the pull did not land the published digest', async () => {
    mockDigest.local.set(image, 'sha256:stuck');
    mockDigest.registry.set(image, 'sha256:new');
    // pullLands intentionally unset — the pull "succeeds" but the local store
    // stays put, which is exactly the stuck case the fallback exists for.
    const result = await forceUpdateService('Local', 'media');
    expect(result.changed).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.logs.join('\n')).toContain('registry serves sha256:new');
  });

  it('fresh mode stops, removes the container AND the local image, then re-pulls', async () => {
    mockDigest.local.set(image, 'sha256:stuck');
    mockDigest.registry.set(image, 'sha256:new');
    mockDigest.pullLands.set(image, 'sha256:new');

    const result = await forceUpdateService('Local', 'media', { fresh: true });

    expect(result.mode).toBe('fresh');
    expect(result.changed).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.images[0].removedLocally).toBe(true);
    // Order is load-bearing: the image can only be deleted once the unit is
    // down and the container is gone, and the pull must come after the delete
    // or it would be served from the local store.
    expect(ran()).toEqual([
      'systemctl --user stop media.service',
      'podman rm -f --ignore media-jellyfin',
      `podman rmi -f ${image}`,
      `podman pull ${image}`,
      'systemctl --user --no-block start media.service',
    ]);
  });

  it('keeps a local image another service is running rather than killing its container', async () => {
    mockTwin.containers = [
      container(),
      container({ id: 'c2', names: ['dashboard-jellyfin'], labels: { PODMAN_SYSTEMD_UNIT: 'dashboard.service' } }),
    ];
    mockDigest.local.set(image, 'sha256:stuck');
    const result = await forceUpdateService('Local', 'media', { fresh: true });
    expect(result.images[0].removedLocally).toBe(false);
    expect(ran()).not.toContain(`podman rmi -f ${image}`);
    // …but it still re-pulls, and only the OWN service's container is removed.
    expect(ran()).toContain(`podman pull ${image}`);
    expect(ran()).toContain('podman rm -f --ignore media-jellyfin');
    expect(ran()).not.toContain('podman rm -f --ignore dashboard-jellyfin');
    expect(result.logs.join('\n')).toContain('another service is running it');
  });

  it('still starts the unit when the local-image delete fails', async () => {
    mockExec.fail.add('podman rmi');
    mockDigest.local.set(image, 'sha256:stuck');
    const result = await forceUpdateService('Local', 'media', { fresh: true });
    expect(result.images[0].removedLocally).toBe(false);
    expect(ran()).toContain('systemctl --user --no-block start media.service');
    expect(result.logs.join('\n')).toContain('Could not delete local image');
  });

  it('never removes a pod infra container (podman owns it via kube down)', async () => {
    mockTwin.containers = [container(), container({ id: 'c3', names: ['media-infra'], isInfra: true })];
    await forceUpdateService('Local', 'media');
    expect(ran()).not.toContain('podman rm -f --ignore media-infra');
  });
});

describe('forceUpdateService (#2419: the rollback anchor is recorded before anything moves)', () => {
  it('logs the pre-update digest before the first pull/stop, and reports it', async () => {
    const image = 'docker.io/jellyfin/jellyfin:latest';
    mockDigest.local.set(image, 'sha256:old');
    mockDigest.registry.set(image, 'sha256:new');
    mockDigest.pullLands.set(image, 'sha256:new');

    const result = await forceUpdateService('Local', 'media');

    // The digest the service ran on must survive even if the caller throws the
    // report away — it is the only thing you can pin to undo a bad update.
    expect(logger.warn).toHaveBeenCalledWith(
      'forceUpdate',
      expect.stringContaining(`TRIGGERED media@Local mode=pull; pre-update digests: ${image}@sha256:old`),
    );
    const anchorIndex = result.logs.findIndex((l) => l.includes('Rollback anchor'));
    const pullIndex = result.logs.findIndex((l) => l.startsWith('Pulling'));
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(anchorIndex).toBeLessThan(pullIndex);
    expect(result.logs[anchorIndex]).toContain(`${image}@sha256:old`);
  });

  it('says "unknown" rather than inventing an anchor when the digest is unreadable', async () => {
    await forceUpdateService('Local', 'media');
    expect(logger.warn).toHaveBeenCalledWith('forceUpdate', expect.stringContaining('@unknown'));
  });

  it('records no anchor when the service declares no image (nothing to roll back)', async () => {
    mockListing.files = { quadletKind: 'kube', kubeContent: '[Kube]', yamlContent: 'spec: {}' };
    const result = await forceUpdateService('Local', 'media');
    expect(result.logs.join('\n')).not.toContain('Rollback anchor');
  });
});
