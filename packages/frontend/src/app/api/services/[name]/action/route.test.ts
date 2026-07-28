/**
 * POST /api/services/:name/action — the lifecycle dispatch the UI uses.
 *
 * #2397 added `force-update` (re-check the registry, re-pull, recreate) with a
 * `mode: fresh` fallback. The scope/session gate is proven in
 * requireSession.test.ts; here the route's OWN wrapper is stubbed but its real
 * zod schemas are applied by the stub, so the action enum is genuinely
 * exercised — a missing enum member fails here instead of 400-ing live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { z } from 'zod';

const mocks = vi.hoisted(() => ({
  forceUpdateService: vi.fn(),
  updateAndRestartService: vi.fn(),
  restartService: vi.fn(),
  getServiceStatus: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: mocks.restartService,
    updateAndRestartService: mocks.updateAndRestartService,
    forceUpdateService: mocks.forceUpdateService,
    getServiceStatus: mocks.getServiceStatus,
  },
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      opts: { body?: z.ZodType<unknown>; query?: z.ZodType<unknown> },
      handler: (ctx: { body: unknown; query: unknown; params: { name: string } }) => Promise<Response>,
    ) =>
    async (request: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
      const raw = await request.text();
      // The REAL schemas from the route module — the point of this stub.
      const body = opts.body ? opts.body.parse(raw ? JSON.parse(raw) : {}) : {};
      const query = opts.query
        ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams))
        : {};
      return handler({ body, query, params: await ctx.params });
    },
}));

import { POST } from './route';

function call(name: string, body: unknown, node?: string) {
  const url = `http://localhost:5888/api/services/${name}/action${node ? `?node=${node}` : ''}`;
  const req = new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ name }) });
}

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.forceUpdateService.mockResolvedValue({ service: 'media', changed: true, stale: false, images: [] });
  mocks.getServiceStatus.mockResolvedValue('Active: active (running)');
});

describe('POST /api/services/:name/action — force-update (#2397)', () => {
  it('dispatches force-update to forceUpdateService with fresh: false by default', async () => {
    const res = await call('media', { action: 'force-update' });
    expect(res.status).toBe(200);
    expect(mocks.forceUpdateService).toHaveBeenCalledWith('Local', 'media', { fresh: false });
    expect(await res.json()).toMatchObject({ changed: true });
  });

  it('passes mode=fresh through as the delete-and-re-pull fallback', async () => {
    await call('media', { action: 'force-update', mode: 'fresh' });
    expect(mocks.forceUpdateService).toHaveBeenCalledWith('Local', 'media', { fresh: true });
  });

  it('targets the node the service runs on', async () => {
    await call('media', { action: 'force-update' }, 'nas01');
    expect(mocks.forceUpdateService).toHaveBeenCalledWith('nas01', 'media', { fresh: false });
  });

  it('leaves restart on its old path (no accidental re-routing)', async () => {
    await call('media', { action: 'restart' });
    expect(mocks.restartService).toHaveBeenCalledWith('Local', 'media');
    expect(mocks.forceUpdateService).not.toHaveBeenCalled();
  });

  it('rejects an action outside the enum and an invalid mode', async () => {
    await expect(call('media', { action: 'force-pull' })).rejects.toThrow();
    await expect(call('media', { action: 'force-update', mode: 'nuke' })).rejects.toThrow();
    expect(mocks.forceUpdateService).not.toHaveBeenCalled();
  });

  it('refuses an invalid service name before touching the node', async () => {
    const res = await call('bad;name', { action: 'force-update' });
    expect(res.status).toBe(400);
    expect(mocks.forceUpdateService).not.toHaveBeenCalled();
  });
});
