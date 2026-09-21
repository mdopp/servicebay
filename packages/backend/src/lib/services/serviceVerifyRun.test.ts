/**
 * #3021 — the gathering, not the judging.
 *
 * `serviceVerify.test.ts` covers the six verdicts as pure functions. This
 * covers the part that composes them, which is where the interesting failures
 * live: a source that cannot be read must become an honest `unknown` rather
 * than a pass or a crash, and the report must still come back.
 *
 * CI caught that this file was missing — the judgements were at 100% and the
 * composition at 31%. Testing the pieces and not the seam is the same mistake
 * that let a deleted call stay green twice today; here it is again, one level
 * out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  ensureAgent: vi.fn(),
  getContainers: vi.fn(),
  getStoreSnapshot: vi.fn(),
  getServiceImageStatus: vi.fn(),
  getServiceFiles: vi.fn(),
  listServices: vi.fn(),
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (...a: unknown[]) => mocks.ensureAgent(...a) },
}));
vi.mock('@/lib/store/repository', () => ({
  getContainers: (...a: unknown[]) => mocks.getContainers(...a),
  getStoreSnapshot: () => mocks.getStoreSnapshot(),
}));
vi.mock('./imageStatus', () => ({ getServiceImageStatus: (...a: unknown[]) => mocks.getServiceImageStatus(...a) }));
vi.mock('./ServiceManager', () => ({
  ServiceManager: {
    getServiceFiles: (...a: unknown[]) => mocks.getServiceFiles(...a),
    listServices: (...a: unknown[]) => mocks.listServices(...a),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { verifyService, containerStateFrom } from './serviceVerifyRun';

const POD = 'apiVersion: v1\nkind: Pod\nmetadata: { name: asteroids }\nspec: { containers: [{ name: web, image: ghcr.io/mdopp/a:latest }] }\n';

const inspectDoc = (over: Record<string, unknown> = {}) => JSON.stringify([{
  RestartCount: 0,
  State: { Status: 'running', StartedAt: '2026-09-21T10:00:00Z', ...(over.State as object ?? {}) },
  ...over,
}]);

function healthy(): void {
  mocks.ensureAgent.mockResolvedValue({ sendCommand: mocks.sendCommand });
  mocks.sendCommand.mockResolvedValue({ code: 0, stdout: inspectDoc() });
  mocks.getContainers.mockReturnValue([
    { names: ['asteroids-web'], labels: { PODMAN_SYSTEMD_UNIT: 'asteroids.service' }, isInfra: false },
  ]);
  mocks.getServiceImageStatus.mockResolvedValue({
    ok: true, summary: 'fine',
    images: [{ image: 'ghcr.io/mdopp/a:latest', published: true, upToDate: true, problem: null }],
  });
  mocks.getServiceFiles.mockResolvedValue({ quadletKind: 'kube', yamlContent: POD });
  mocks.getStoreSnapshot.mockReturnValue({ proxyState: { routes: [] } });
  mocks.listServices.mockResolvedValue([{ name: 'asteroids' }]);
}

describe('verifyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthy();
  });

  it('measures all six points and reports done when every one passes', async () => {
    const r = await verifyService('Local', 'asteroids');
    expect(r.checks.map(c => c.id)).toEqual(['health', 'restarts', 'image', 'manifest', 'proxy-route', 'public-url']);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
  });

  it('strips a unit suffix, so `asteroids.service` and `asteroids` are one service', async () => {
    const r = await verifyService('Local', 'asteroids.service');
    expect(r.service).toBe('asteroids');
  });

  it('only inspects the containers this service owns', async () => {
    mocks.getContainers.mockReturnValue([
      { names: ['asteroids-web'], labels: { PODMAN_SYSTEMD_UNIT: 'asteroids.service' }, isInfra: false },
      { names: ['media-jellyfin'], labels: { PODMAN_SYSTEMD_UNIT: 'media.service' }, isInfra: false },
      { names: ['asteroids-infra'], labels: { PODMAN_SYSTEMD_UNIT: 'asteroids.service' }, isInfra: true },
    ]);
    await verifyService('Local', 'asteroids');
    const inspected = mocks.sendCommand.mock.calls.map(([, p]) => (p as { argv: string[] }).argv.at(-1));
    expect(inspected).toEqual(['asteroids-web']);
  });

  it('an unreachable node makes the container checks UNKNOWN, not ok and not a crash', async () => {
    mocks.ensureAgent.mockRejectedValue(new Error('node unreachable'));
    const r = await verifyService('Local', 'asteroids');
    const byId = Object.fromEntries(r.checks.map(c => [c.id, c.status]));
    expect(byId.health).toBe('unknown');
    expect(byId.restarts).toBe('unknown');
    expect(r.ok).toBe(true);        // nothing FAILED …
    expect(r.complete).toBe(false); // … but it is not verified either
  });

  it('an image status that throws is unknown, and the rest of the report still arrives', async () => {
    mocks.getServiceImageStatus.mockRejectedValue(new Error('podman gone'));
    const r = await verifyService('Local', 'asteroids');
    expect(r.checks.find(c => c.id === 'image')?.status).toBe('unknown');
    expect(r.checks).toHaveLength(6);
  });

  it('a .container unit has no pod spec, so the manifest check is skipped', async () => {
    mocks.getServiceFiles.mockResolvedValue({ quadletKind: 'container', kubeContent: 'Image=x\n' });
    const r = await verifyService('Local', 'asteroids');
    expect(r.checks.find(c => c.id === 'manifest')?.status).toBe('skipped');
  });

  it('probes the public URL only when a route points at this service', async () => {
    const probeUrl = vi.fn(async (host: string) => ({ url: `https://${host}/`, status: 200 }));
    await verifyService('Local', 'asteroids', { probeUrl });
    expect(probeUrl).not.toHaveBeenCalled();

    mocks.getStoreSnapshot.mockReturnValue({
      proxyState: { routes: [{ host: 'asteroids.dopp.cloud', targetService: 'asteroids', targetPort: 8080 }] },
    });
    const r = await verifyService('Local', 'asteroids', { probeUrl });
    expect(probeUrl).toHaveBeenCalledWith('asteroids.dopp.cloud');
    expect(r.checks.find(c => c.id === 'public-url')?.status).toBe('ok');
  });

  it('a route naming a deleted service is reported even while this service is fine', async () => {
    // The real one: the route still resolved because another service happened
    // to hold the port, so nothing else looked wrong.
    mocks.getStoreSnapshot.mockReturnValue({
      proxyState: { routes: [{ host: 'asteroids.dopp.cloud', targetService: 'asteroids', targetPort: 8080 }] },
    });
    mocks.listServices.mockResolvedValue([{ name: 'media' }]);
    const r = await verifyService('Local', 'asteroids', { probeUrl: async h => ({ url: `https://${h}/`, status: 200 }) });
    expect(r.checks.find(c => c.id === 'proxy-route')?.status).toBe('problem');
    expect(r.ok).toBe(false);
  });

  it('a restarting container fails the report, with the health-log reason', async () => {
    mocks.sendCommand.mockResolvedValue({
      code: 0,
      stdout: inspectDoc({
        RestartCount: 1006,
        State: {
          Status: 'running',
          StartedAt: new Date().toISOString(),
          Health: { Status: 'unhealthy', FailingStreak: 300, Log: [{ Output: 'sh: curl: not found' }] },
        },
      }),
    });
    const r = await verifyService('Local', 'asteroids');
    expect(r.ok).toBe(false);
    expect(r.checks.find(c => c.id === 'restarts')?.status).toBe('problem');
    expect(r.checks.find(c => c.id === 'health')?.detail).toContain('curl: not found');
  });

  it('an inspect that fails for one container drops it rather than failing the run', async () => {
    mocks.sendCommand.mockResolvedValue({ code: 1, stdout: '' });
    const r = await verifyService('Local', 'asteroids');
    expect(r.checks.find(c => c.id === 'health')?.status).toBe('unknown');
    expect(r.checks).toHaveLength(6);
  });

  it('unparseable inspect output does not take the report with it', async () => {
    mocks.sendCommand.mockResolvedValue({ code: 0, stdout: '{{ not json' });
    await expect(verifyService('Local', 'asteroids')).resolves.toBeDefined();
  });

  it('a proxy store that throws leaves the route check honest and the report intact', async () => {
    mocks.getStoreSnapshot.mockImplementation(() => { throw new Error('store not ready'); });
    const r = await verifyService('Local', 'asteroids');
    expect(r.checks).toHaveLength(6);
    expect(r.checks.find(c => c.id === 'proxy-route')?.status).toBe('skipped');
  });
});

describe('containerStateFrom — guarding the parse the whole report rests on', () => {
  it('reads restart count, start time and the last health line together', () => {
    const c = containerStateFrom('web', inspectDoc({
      RestartCount: 7,
      State: {
        Status: 'running',
        StartedAt: '2026-09-21T10:00:00Z',
        Health: { Status: 'unhealthy', FailingStreak: 4, Log: [{ Output: 'old' }, { Output: 'newest\n' }] },
      },
    }));
    expect(c).toMatchObject({ name: 'web', restartCount: 7, startedAt: '2026-09-21T10:00:00Z' });
    expect(c.health).toMatchObject({ status: 'unhealthy', failingStreak: 4, lastOutput: 'newest' });
  });
});
