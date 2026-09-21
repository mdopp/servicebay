/**
 * GET /api/services/[name]/images — the read that tells an agent where its
 * image stopped (#2995).
 *
 * This file exists because of what the deployed build actually did. Measured on
 * 5.41.0, a service name nobody has answered:
 *
 *     GET /api/services/definitely-not-a-route/images -> 500 {"error":"Internal error"}
 *
 * `getServiceFiles` throws for an unknown service and the catch turned it into
 * an internal error. That is precisely the unreadable refusal this verb was
 * built to replace, shipped inside the verb itself — and the one case an agent
 * hits most, because getting the service name wrong is the ordinary mistake.
 *
 * So: a name no service has is a 404 that names the fix, and the route's
 * wrapper is stubbed while its real zod query schema is applied, the same shape
 * the sibling route tests use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { z } from 'zod';

const mocks = vi.hoisted(() => ({
  listServices: vi.fn(),
  getServiceImageStatus: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: mocks.listServices },
}));
vi.mock('@/lib/services/imageStatus', () => ({ getServiceImageStatus: mocks.getServiceImageStatus }));
vi.mock('@/lib/api/errors', () => ({
  apiError: () => new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 }),
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      opts: { query?: z.ZodType<unknown> },
      handler: (ctx: { query: unknown; params: { name: string } }) => Promise<Response>,
    ) =>
    async (request: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
      const query = opts.query
        ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams))
        : {};
      return handler({ query, params: await ctx.params });
    },
}));

import { GET } from './route';

function call(name: string, node?: string) {
  const url = `http://localhost:5888/api/services/${name}/images${node ? `?node=${node}` : ''}`;
  return GET(new NextRequest(url), { params: Promise.resolve({ name }) });
}

const REPORT = { service: 'media', node: 'Local', images: [], ok: false, summary: 'no image reference' };

describe('GET /api/services/[name]/images (#2995)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listServices.mockResolvedValue([{ name: 'media' }, { name: 'immich' }]);
    mocks.getServiceImageStatus.mockResolvedValue(REPORT);
  });

  it('answers the report for a service that exists', async () => {
    const res = await call('media');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(mocks.getServiceImageStatus).toHaveBeenCalledWith('Local', 'media');
  });

  it('a name no service has is 404 and names the fix — not 500 (measured on 5.41.0)', async () => {
    const res = await call('definitely-not-a-route');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('No service named');
    expect(body.error).toContain('servicebay services');
    // And it must not have gone on to throw its way into an internal error.
    expect(mocks.getServiceImageStatus).not.toHaveBeenCalled();
  });

  it('checks existence on the node that was asked about', async () => {
    mocks.listServices.mockResolvedValue([{ name: 'media' }]);
    const res = await call('media', 'kitchen-pi');
    expect(res.status).toBe(200);
    expect(mocks.listServices).toHaveBeenCalledWith('kitchen-pi');
    expect(mocks.getServiceImageStatus).toHaveBeenCalledWith('kitchen-pi', 'media');
  });

  it('a node that cannot be listed does not turn every name into a 404 lie', async () => {
    // `listServices` rejecting means we do not KNOW the service is missing. A
    // failed listing is not an empty one, and claiming 404 would send someone
    // hunting a typo that is not there — every name would "not exist" the
    // moment a node went unreachable.
    mocks.listServices.mockRejectedValue(new Error('node unreachable'));
    const res = await call('media');
    expect(res.status).not.toBe(404);
    expect(mocks.getServiceImageStatus).toHaveBeenCalled();
  });

  it('claims absence only for a name that was genuinely enumerated away', async () => {
    mocks.listServices.mockResolvedValue([{ name: 'immich' }]);
    const res = await call('media');
    expect(res.status).toBe(404);
    expect(mocks.getServiceImageStatus).not.toHaveBeenCalled();
  });

  it('a genuine failure inside the report is still a 500, not a fake 404', async () => {
    mocks.getServiceImageStatus.mockRejectedValue(new Error('podman exploded'));
    const res = await call('media');
    expect(res.status).toBe(500);
  });

  it('declares tokenScope read — it inspects and changes nothing', async () => {
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(src).toMatch(/tokenScope:\s*'read'/);
    // GET only. A mutating verb next to a read one on the same path is how a
    // "just have a look" call grows teeth; the mutating twin is POST …/action.
    expect(src).toMatch(/export const GET/);
    expect(src).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/);
  });
});
