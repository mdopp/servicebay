/**
 * POST /napi/services/:name/operate — companion-app service control (#2253).
 *
 * The gate/scope machinery (accept a `lifecycle` Bearer, 401 a read/absent
 * token) is proven in requireSession.test.ts, and the EXACT `lifecycle` scope
 * baked into this route's OPTIONS is pinned in ../../../scopeGuards.test.ts.
 * Here we exercise the route body: each action forwards to the matching
 * ServiceManager lifecycle primitive, an invalid name 400s, and the node query
 * threads through — with `withApiHandlerParams` stubbed to inject `auth` the way
 * the real gate would (same shape as the browser approve route test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  startService: vi.fn(),
  stopService: vi.fn(),
  restartService: vi.fn(),
  authRef: { value: { user: 'token:device' } as { user: string } | undefined },
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    startService: mocks.startService,
    stopService: mocks.stopService,
    restartService: mocks.restartService,
  },
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      _opts: unknown,
      handler: (ctx: {
        body: { action: string };
        query: { node?: string };
        params: { name: string };
        auth?: { user: string };
      }) => Promise<Response>,
    ) =>
    async (
      request: NextRequest,
      ctx: { params: Promise<{ name: string }> },
    ) => {
      const raw = await request.text();
      const body = raw ? JSON.parse(raw) : {};
      const node = new URL(request.url).searchParams.get('node') ?? undefined;
      return handler({ body, query: { node }, params: await ctx.params, auth: mocks.authRef.value });
    },
}));

import { POST } from './route';

function call(name: string, action: string, node?: string) {
  const url = `http://localhost:5888/napi/services/${name}/operate${node ? `?node=${node}` : ''}`;
  const req = new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return POST(req, { params: Promise.resolve({ name }) });
}

describe('POST /napi/services/:name/operate — lifecycle control', () => {
  beforeEach(() => {
    mocks.startService.mockReset().mockResolvedValue(undefined);
    mocks.stopService.mockReset().mockResolvedValue(undefined);
    mocks.restartService.mockReset().mockResolvedValue(undefined);
  });

  it('start → calls startService(Local, name) and returns ok (acceptance #1)', async () => {
    const res = await call('immich', 'start');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'immich', action: 'start' });
    expect(mocks.startService).toHaveBeenCalledWith('Local', 'immich');
    expect(mocks.stopService).not.toHaveBeenCalled();
  });

  it('stop → calls stopService', async () => {
    const res = await call('immich', 'stop');
    expect(res.status).toBe(200);
    expect(mocks.stopService).toHaveBeenCalledWith('Local', 'immich');
  });

  it('restart → calls restartService', async () => {
    const res = await call('immich', 'restart');
    expect(res.status).toBe(200);
    expect(mocks.restartService).toHaveBeenCalledWith('Local', 'immich');
  });

  it('threads the node query through to the lifecycle call', async () => {
    await call('immich', 'restart', 'box2');
    expect(mocks.restartService).toHaveBeenCalledWith('box2', 'immich');
  });

  it('invalid service name → 400, no lifecycle call', async () => {
    const res = await call('bad name!', 'start');
    expect(res.status).toBe(400);
    expect(mocks.startService).not.toHaveBeenCalled();
  });

  it('a lifecycle failure surfaces as 500, not a false-green ok', async () => {
    mocks.startService.mockRejectedValue(new Error('unit failed'));
    const res = await call('immich', 'start');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).not.toBe(true);
  });
});
