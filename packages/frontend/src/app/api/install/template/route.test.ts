/**
 * POST /api/install/template — the mutate-tier install route the agent CLI's
 * `install` verb speaks (#2990).
 *
 * The route's own wrapper is stubbed, but its REAL zod schema is applied by the
 * stub, so a body the schema would reject is genuinely rejected here — the same
 * shape `[name]/action/route.test.ts` uses. The scope gate itself is proven in
 * `requireSession.test.ts`; what is pinned here is the tier the route declares,
 * because the CLI prints that word on every refusal and the two must not drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import type { z } from 'zod';

const mocks = vi.hoisted(() => ({
  startTemplateInstall: vi.fn(),
  getCurrentJob: vi.fn(),
}));

vi.mock('@/lib/install/startTemplateInstall', () => ({
  startTemplateInstall: mocks.startTemplateInstall,
}));
vi.mock('@/lib/install/jobStore', () => ({ getCurrentJob: mocks.getCurrentJob }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      opts: { body?: z.ZodType<unknown> },
      handler: (ctx: { body: unknown; request: NextRequest }) => Promise<Response>,
    ) =>
    async (request: NextRequest) => {
      const raw = await request.text();
      // The REAL schema from the route module — the point of this stub.
      const parsed = opts.body ? opts.body.safeParse(raw ? JSON.parse(raw) : {}) : { success: true, data: {} };
      if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
      return handler({ body: (parsed as { data: unknown }).data, request });
    },
}));

import { POST } from './route';

function call(body: unknown) {
  return POST(
    new NextRequest('http://localhost:5888/api/install/template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/install/template (#2990)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.startTemplateInstall.mockResolvedValue({ jobId: 'job-1', phase: 'running' });
  });

  it('declares tokenScope mutate — the tier install_template has held since #2141', () => {
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(src).toMatch(/tokenScope:\s*'mutate'/);
    // Its sibling only ASKS and sits on the off-ladder `propose` tier. If these
    // two ever carry the same word, one of them is wrong (ADR 0017).
    const asks = readFileSync(path.join(__dirname, '..', 'requests', 'route.ts'), 'utf8');
    expect(asks).toMatch(/tokenScope:\s*'propose'/);
  });

  it('starts the install and answers with the job it started', async () => {
    const res = await call({ template: 'asteroids', variables: { PORT: '8080' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'job-1', phase: 'running' });
    expect(mocks.startTemplateInstall).toHaveBeenCalledWith({
      names: ['asteroids'],
      variables: { PORT: '8080' },
    });
  });

  it('cannot be asked for a wipe: an install started this way is additive (ADR 0004)', async () => {
    await call({ template: 'asteroids', wipeMode: 'wipe-all' });
    // The schema drops the unknown key, so it never reaches the installer —
    // asserted against the REAL call, not against the schema's shape.
    expect(mocks.startTemplateInstall).toHaveBeenCalledTimes(1);
    expect(mocks.startTemplateInstall.mock.calls[0][0]).not.toHaveProperty('wipeMode');
  });

  it('refuses an empty template name rather than assembling nothing', async () => {
    const res = await call({ template: '' });
    expect(res.status).toBe(400);
    expect(mocks.startTemplateInstall).not.toHaveBeenCalled();
  });

  it('refuses a second install while one is running, instead of racing it', async () => {
    mocks.getCurrentJob.mockResolvedValue({ id: 'job-running', phase: 'running' });
    const res = await call({ template: 'asteroids' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('job-running') });
    expect(mocks.startTemplateInstall).not.toHaveBeenCalled();
  });

  it('reports a failed start as a failure, not as a started job', async () => {
    // The #2983 shape, in this route's terms: a 200 carrying no job would read
    // as "installing" to every caller.
    mocks.startTemplateInstall.mockRejectedValue(new Error('no such template'));
    const res = await call({ template: 'nope' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('no such template') });
  });
});
