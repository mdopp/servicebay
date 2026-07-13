/**
 * GET /api/containers/[id]/logs/stream — the container-logs fetch seam.
 *
 * Regression guard for js/stack-trace-exposure: when the underlying agent call
 * throws, the 500 response body must be a generic message — the real error's
 * message/stack must NOT reach the HTTP client. The detail is logged
 * server-side (console.error) only.
 *
 * The handler wrapper and agent manager are mocked so the test drives the
 * route's error path directly, without a live agent or the auth stack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { getAgent: mocks.getAgent },
}));

// Run the wrapped handler directly, parsing the `node` query, with a stub
// params promise — no auth gate, no schema plumbing under test here.
vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      _opts: unknown,
      handler: (ctx: {
        query: { node?: string };
        params: { id: string };
      }) => Promise<Response>,
    ) =>
    async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
      const params = await ctx.params;
      const node = new URL(request.url).searchParams.get('node') ?? undefined;
      return handler({ query: { node }, params });
    },
}));

const { GET } = await import('./route');

const SECRET = 'agent socket ECONNREFUSED /run/secret/podman.sock at Object.<anonymous>';

function call(id = 'valid-container') {
  const req = new NextRequest(`http://localhost/api/containers/${id}/logs/stream`);
  return GET(req, { params: Promise.resolve({ id }) });
}

describe('GET /api/containers/[id]/logs/stream — stack-trace-exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a generic 500 body — no internal error message leaks', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getAgent.mockImplementation(() => {
      throw new Error(SECRET);
    });

    const res = await call();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe('internal server error');
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('ECONNREFUSED');

    // Real detail is preserved server-side.
    expect(errSpy).toHaveBeenCalledWith(
      'Error streaming container logs:',
      expect.objectContaining({ message: SECRET }),
    );
    errSpy.mockRestore();
  });
});
