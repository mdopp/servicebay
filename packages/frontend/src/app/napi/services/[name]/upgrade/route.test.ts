/**
 * POST /napi/services/:name/upgrade — companion-app upgrade-apply (#2313).
 *
 * The scope machinery (accept a `mutate` Bearer, 401/403 a read/lifecycle/absent
 * token) is proven in requireSession.test.ts, and the EXACT `mutate` scope baked
 * into this route's OPTIONS is pinned in ../../../scopeGuards.test.ts. Here we
 * exercise the route body: it reuses the SAME primitives the browser uses —
 * `ServiceManager.updateAndRestartService` for an image update and
 * `assembleManifest → applyVariableDefaults → createJob → startJob` for a
 * template re-deploy — selecting by pending kind, with an invalid name 400 and a
 * no-pending clean no-op (not a crash). `withApiHandlerParams` is stubbed to
 * inject params the way the real gate would (same shape as the operate test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  updateAndRestartService: vi.fn(),
  getPendingTemplateUpgrades: vi.fn(),
  getInstalledImageUpdates: vi.fn(),
  assembleManifest: vi.fn(),
  applyVariableDefaults: vi.fn(),
  createJob: vi.fn(),
  getCurrentJob: vi.fn(),
  startJob: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { updateAndRestartService: mocks.updateAndRestartService },
}));
vi.mock('@/lib/templateUpgrades', () => ({
  getPendingTemplateUpgrades: mocks.getPendingTemplateUpgrades,
}));
vi.mock('@/lib/imageDigest', () => ({
  getInstalledImageUpdates: mocks.getInstalledImageUpdates,
}));
vi.mock('@/lib/install/manifestAssembler', () => ({
  assembleManifest: mocks.assembleManifest,
  applyVariableDefaults: mocks.applyVariableDefaults,
}));
vi.mock('@/lib/install/jobStore', () => ({
  createJob: mocks.createJob,
  getCurrentJob: mocks.getCurrentJob,
  // Real subclass of Error so `instanceof` in the route works.
  InstallInProgressError: class InstallInProgressError extends Error {
    existingJobId: string;
    constructor(id: string) {
      super('install in progress');
      this.name = 'InstallInProgressError';
      this.existingJobId = id;
    }
  },
}));
vi.mock('@/lib/install/runner', () => ({ startJob: mocks.startJob }));

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      _opts: unknown,
      handler: (ctx: {
        body: { kind?: string };
        query: { node?: string };
        params: { name: string };
      }) => Promise<Response>,
    ) =>
    async (request: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
      const raw = await request.text();
      const body = raw ? JSON.parse(raw) : {};
      const node = new URL(request.url).searchParams.get('node') ?? undefined;
      return handler({ body, query: { node }, params: await ctx.params });
    },
}));

import { POST } from './route';

function call(name: string, kind?: string, node?: string) {
  const url = `http://localhost:5888/napi/services/${name}/upgrade${node ? `?node=${node}` : ''}`;
  const req = new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kind ? { kind } : {}),
  });
  return POST(req, { params: Promise.resolve({ name }) });
}

/** No template + no image pending for anyone, by default. Individual tests
 *  override to make a specific kind pending for `immich`. */
function pending(opts: { template?: boolean; image?: boolean } = {}) {
  mocks.getPendingTemplateUpgrades.mockResolvedValue(
    opts.template ? [{ name: 'immich', installedVersion: 1, currentVersion: 2 }] : [],
  );
  mocks.getInstalledImageUpdates.mockResolvedValue(
    opts.image ? [{ service: 'immich', updateAvailable: true }] : [],
  );
}

describe('POST /napi/services/:name/upgrade — apply a pending upgrade', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(m => m.mockReset());
    mocks.updateAndRestartService.mockResolvedValue({ logs: ['pulled'], status: 'active' });
    mocks.assembleManifest.mockResolvedValue({ items: [{ name: 'immich', checked: true }], variables: [] });
    mocks.applyVariableDefaults.mockImplementation(async (i: unknown) => i);
    mocks.createJob.mockResolvedValue({ id: 'job-1', phase: 'running' });
    mocks.getCurrentJob.mockResolvedValue(null);
    pending();
  });

  it('kind=image with an image pending → calls updateAndRestartService(node, name) (acceptance: mutate token upgrades)', async () => {
    pending({ image: true });
    const res = await call('immich', 'image');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('image');
    expect(mocks.updateAndRestartService).toHaveBeenCalledWith('Local', 'immich');
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('kind=template with a template pending → drives assemble→createJob→startJob for the service', async () => {
    pending({ template: true });
    const res = await call('immich', 'template');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('template');
    expect(body.jobId).toBe('job-1');
    expect(mocks.assembleManifest).toHaveBeenCalledWith({ items: [{ name: 'immich', checked: true }] });
    expect(mocks.createJob).toHaveBeenCalledWith({ source: 'napi', input: expect.objectContaining({ node: 'Local' }) });
    expect(mocks.startJob).toHaveBeenCalledWith('job-1');
    expect(mocks.updateAndRestartService).not.toHaveBeenCalled();
  });

  it('default (no kind) applies the image update when one is pending, image before template', async () => {
    pending({ image: true, template: true });
    const res = await call('immich');
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe('image');
    expect(mocks.updateAndRestartService).toHaveBeenCalledWith('Local', 'immich');
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('default (no kind) falls through to the template re-deploy when only a template upgrade is pending', async () => {
    pending({ template: true });
    const res = await call('immich');
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe('template');
    expect(mocks.startJob).toHaveBeenCalledWith('job-1');
  });

  it('threads the node query through to the image upgrade primitive', async () => {
    pending({ image: true });
    await call('immich', 'image', 'box2');
    expect(mocks.updateAndRestartService).toHaveBeenCalledWith('box2', 'immich');
  });

  it('no upgrade pending → clean no-op 200 (applied:false), not a crash', async () => {
    pending(); // nothing pending
    const res = await call('immich');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(mocks.updateAndRestartService).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('kind=image but nothing pending → clean no-op, no image pull', async () => {
    pending({ template: true }); // template pending, but caller asked for image
    const res = await call('immich', 'image');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(mocks.updateAndRestartService).not.toHaveBeenCalled();
  });

  it('template re-deploy while an install job is already running → 409, no new job', async () => {
    pending({ template: true });
    mocks.getCurrentJob.mockResolvedValue({ id: 'busy-job' });
    const res = await call('immich', 'template');
    expect(res.status).toBe(409);
    expect((await res.json()).jobId).toBe('busy-job');
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('invalid service name → 400, nothing applied', async () => {
    const res = await call('bad name!');
    expect(res.status).toBe(400);
    expect(mocks.updateAndRestartService).not.toHaveBeenCalled();
    expect(mocks.getPendingTemplateUpgrades).not.toHaveBeenCalled();
  });

  it('an image-pull failure surfaces as 500, not a false-green ok', async () => {
    pending({ image: true });
    mocks.updateAndRestartService.mockRejectedValue(new Error('pull failed'));
    const res = await call('immich', 'image');
    expect(res.status).toBe(500);
    expect((await res.json()).ok).not.toBe(true);
  });
});
