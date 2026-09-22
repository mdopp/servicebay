/**
 * POST /api/system/template-sources (#3035).
 *
 * Thin by design — the work is in `addTemplateSource` — but the two things it
 * owns are exactly the ones that would otherwise be wrong in the direction this
 * whole surface has been cleaned of:
 *
 *  1. the tier: `mutate`, the same one installing a template needs, because
 *     this writes config and then clones a repo;
 *  2. a refusal that says WHY. A `TemplateSourceError` carries a message
 *     written for the caller; turning it into a bare 500 would put the caller
 *     back to guessing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import type { z } from 'zod';

// The error class must be created inside `vi.hoisted` too: `vi.mock`'s factory
// is hoisted above ordinary top-level declarations, so a class defined below it
// is not initialised yet when the mock is built.
const mocks = vi.hoisted(() => {
  class FakeSourceError extends Error {
    constructor(message: string, public readonly status = 400) { super(message); }
  }
  return { addTemplateSource: vi.fn(), FakeSourceError };
});
const FakeSourceError = mocks.FakeSourceError;

vi.mock('@/lib/services/templateSources', () => ({
  addTemplateSource: mocks.addTemplateSource,
  TemplateSourceError: mocks.FakeSourceError,
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (opts: { body?: z.ZodType<unknown> }, handler: (ctx: { body: unknown }) => Promise<Response>) =>
    async (request: NextRequest) => {
      const raw = await request.text();
      const parsed = opts.body ? opts.body.safeParse(raw ? JSON.parse(raw) : {}) : { success: true, data: {} };
      if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
      return handler({ body: (parsed as { data: unknown }).data });
    },
}));

import { POST } from './route';

const call = (body: unknown) =>
  POST(new NextRequest('http://localhost:5888/api/system/template-sources', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

describe('POST /api/system/template-sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addTemplateSource.mockResolvedValue({ name: 'flutstunde', url: 'https://x/y.git', added: true, synced: true, detail: 'ok' });
  });

  it('declares tokenScope mutate — it writes config and then clones a repo', () => {
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(src).toMatch(/tokenScope:\s*'mutate'/);
  });

  it('passes the url through and answers with the registration', async () => {
    const res = await call({ url: 'https://x/y.git' });
    expect(res.status).toBe(200);
    expect(mocks.addTemplateSource).toHaveBeenCalledWith({ url: 'https://x/y.git' });
    expect(await res.json()).toMatchObject({ name: 'flutstunde', synced: true });
  });

  it('relays a refusal with its reason, not as a bare 500', async () => {
    mocks.addTemplateSource.mockRejectedValue(new FakeSourceError('"/mnt/data" is a local path, not a repository URL.'));
    const res = await call({ url: '/mnt/data' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('local path');
  });

  it('an unexpected failure is a 500 that leaks nothing', async () => {
    mocks.addTemplateSource.mockRejectedValue(new Error('ENOENT /root/.gitconfig'));
    const res = await call({ url: 'https://x/y.git' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('ENOENT');
  });

  it('refuses an empty url at the schema, before anything is written', async () => {
    const res = await call({ url: '' });
    expect(res.status).toBe(400);
    expect(mocks.addTemplateSource).not.toHaveBeenCalled();
  });
});
