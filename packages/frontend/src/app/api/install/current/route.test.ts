/**
 * GET /api/install/current — and, since #3027, "how did the last one end".
 *
 * The complaint this answers: `servicebay install` prints a job id, the session
 * polls, the job ends, and the answer becomes "no install job is running" while
 * the outcome sits on disk —
 *
 *     { "phase": "error",
 *       "error": "Nothing was deployed: 0 of 1 requested service(s) reached the box (flutstunde)." }
 *
 * A good message that reached nobody. Three attempts followed, guessing at a
 * fact that was recorded the whole time.
 *
 * Two things must hold and both are places this would quietly be wrong:
 *
 *  1. **`job` / `jobIsActive` keep their meaning.** The sb launcher reattaches
 *     on them; a terminal job leaking into `job` would make it offer to
 *     reattach to something that is over.
 *  2. **No secret leaves.** `/status` is cookie-only precisely because the job
 *     carries `input.variables` — operator passwords. This route is
 *     `read`-token reachable, so the summary must never carry them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { z } from 'zod';

const mocks = vi.hoisted(() => ({
  getCurrentJob: vi.fn(),
  getLatestJob: vi.fn(),
  getJob: vi.fn(),
  readLog: vi.fn(),
}));

vi.mock('@/lib/install/jobStore', () => ({
  getCurrentJob: mocks.getCurrentJob,
  getLatestJob: mocks.getLatestJob,
  getJob: mocks.getJob,
  readLog: mocks.readLog,
}));
vi.mock('@/lib/mcp/redact', () => ({ redactLogText: (s: string) => s.replace(/hunter2/g, '<redacted>') }));
vi.mock('@/lib/api/errors', () => ({
  apiError: () => new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 }),
}));
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (opts: { query?: z.ZodType<unknown> }, handler: (ctx: { query: unknown }) => Promise<Response>) =>
    async (request: NextRequest) => {
      const query = opts.query ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams)) : {};
      return handler({ query });
    },
}));

import { GET } from './route';

const job = (over: Record<string, unknown> = {}) => ({
  id: '57fa8f30',
  phase: 'error',
  startedAt: '2026-09-22T05:00:00Z',
  endedAt: '2026-09-22T05:02:00Z',
  error: 'Nothing was deployed: 0 of 1 requested service(s) reached the box (flutstunde).',
  warnings: [],
  progress: { currentItem: null, deployedNames: [], totalCount: 1 },
  // The half that must NEVER leave: /status is cookie-only because of this.
  input: { variables: { ADMIN_PASSWORD: 'hunter2' } },
  ...over,
});

const call = (qs = '') => GET(new NextRequest(`http://localhost:5888/api/install/current${qs}`));

describe('GET /api/install/current (#3027)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readLog.mockResolvedValue({ content: '❌ flutstunde carries no template spec in this manifest.\n' });
  });

  it('reports a running job as active, as it always did', async () => {
    mocks.getCurrentJob.mockResolvedValue(job({ phase: 'running', error: null, endedAt: undefined }));
    const body = await (await call()).json();
    expect(body.jobIsActive).toBe(true);
    expect(body.job.phase).toBe('running');
    expect(body.last).toBeUndefined();
    expect(mocks.getLatestJob).not.toHaveBeenCalled();
  });

  it('with nothing running, reports HOW THE LAST ONE ENDED — the whole point', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(job());
    const body = await (await call()).json();
    expect(body.job).toBeNull();
    expect(body.jobIsActive).toBe(false);
    expect(body.last.phase).toBe('error');
    expect(body.last.error).toContain('Nothing was deployed');
    expect(body.last.logTail.join(' ')).toContain('no template spec');
  });

  it('keeps a terminal job OUT of `job` — the launcher reattaches on that field', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(job());
    const body = await (await call()).json();
    expect(body.job).toBeNull();
    expect(body.jobIsActive).toBe(false);
  });

  it('a box that never ran an install says so without inventing a `last`', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body).toEqual({ job: null, jobIsActive: false });
  });

  it('redeems the id `install` prints, whatever phase it is in', async () => {
    mocks.getJob.mockResolvedValue(job({ phase: 'done', error: null }));
    const body = await (await call('?jobId=57fa8f30')).json();
    expect(mocks.getJob).toHaveBeenCalledWith('57fa8f30');
    expect(body.job.id).toBe('57fa8f30');
    expect(body.jobIsActive).toBe(false);
    // and it did not fall back to "whatever is current"
    expect(mocks.getCurrentJob).not.toHaveBeenCalled();
  });

  it('an unknown id is a 404 that says where ids come from', async () => {
    mocks.getJob.mockResolvedValue(null);
    const res = await call('?jobId=nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('servicebay install');
  });

  it('never returns the operator secrets that keep /status cookie-only', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(job());
    const text = await (await call()).text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ADMIN_PASSWORD');
    expect(text).not.toContain('variables');
  });

  it('redacts the log tail, like every other box-derived text', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(job());
    mocks.readLog.mockResolvedValue({ content: 'password: hunter2\nstarting\n' });
    const text = await (await call()).text();
    expect(text).toContain('<redacted>');
    expect(text).not.toContain('hunter2');
  });

  it('an unreadable log does not take the answer with it', async () => {
    mocks.getCurrentJob.mockResolvedValue(null);
    mocks.getLatestJob.mockResolvedValue(job());
    mocks.readLog.mockRejectedValue(new Error('log gone'));
    const body = await (await call()).json();
    expect(body.last.error).toContain('Nothing was deployed');
    expect(body.last.logTail).toEqual([]);
  });
});
