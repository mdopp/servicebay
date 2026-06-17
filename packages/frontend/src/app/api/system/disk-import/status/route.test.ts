/**
 * GET /api/system/disk-import/status (#1930) — disk-import routing-tree API smoke.
 *
 * The routing-tree review UI (#1915, shipped in #1918) hangs off this endpoint:
 * once a scan reaches `reviewed`, the status payload carries the `review` object
 * the card renders — `phase`, per-`categories` sizing, the per-folder `tree`,
 * the `boxUsers` that drive the Owner picker, and the disk `defaultOwner`. The
 * card can't render the routing tree without that exact shape.
 *
 * The dev/verify env can't launch headless Chromium (libnspr4/libatk/libdbus
 * missing — see tests/e2e/README.md), so the browser-rendered smoke for this
 * page has stayed deferred across box-verifies. This test gives Box-Verify a
 * non-browser way to assert the routing-tree endpoint is wired and returns the
 * shape the UI depends on. Full browser verification is tracked by epic #1473.
 *
 * The engine service (`@/lib/diskImport/service`) is mocked so the test exercises
 * the route's wiring (job lookup, 200 shape, 404 on unknown id) without a real
 * disk scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getImportJob: vi.fn(),
}));
const { getImportJob } = mocks;

vi.mock('@/lib/diskImport/service', () => ({
  getImportJob: mocks.getImportJob,
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      _opts: unknown,
      handler: (ctx: { query: { id: string }; auth?: unknown }) => Promise<Response>,
    ) =>
    async (request: NextRequest) => {
      const id = new URL(request.url).searchParams.get('id') ?? '';
      return handler({ query: { id }, auth: { user: 'op' } });
    },
}));

import { GET } from './route';

function req(id: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/system/disk-import/status?id=${encodeURIComponent(id)}`,
  );
}

/** A `reviewed` job carrying the routing-tree review payload the UI renders. */
function reviewedJob() {
  return {
    sessionId: 'sess-1',
    device: '/dev/sda1',
    phase: 'reviewed' as const,
    progress: { step: 'reviewed' },
    review: {
      sessionId: 'sess-1',
      device: '/dev/sda1',
      totalFiles: 3,
      totalBytes: 4096,
      categories: [
        { category: 'photos', files: 3, bytes: 4096, copy: 3, skipDupe: 0, conflict: 0 },
      ],
      actions: [],
      tree: [
        {
          dir: 'alice',
          files: 3,
          bytes: 4096,
          categories: ['photos'],
          explicit: { owner: 'alice' },
          resolved: {
            disposition: 'auto',
            mode: 'merge',
            owner: 'alice',
            anchor: 'alice',
          },
        },
      ],
      boxUsers: ['alice', 'bob'],
      defaultOwner: 'shared',
    },
  };
}

describe('GET /api/system/disk-import/status — routing-tree API smoke (#1930)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the routing-tree review shape the UI depends on', async () => {
    getImportJob.mockResolvedValue(reviewedJob());

    const res = await GET(req('sess-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Top-level job shape.
    expect(body.ok).toBe(true);
    expect(body.phase).toBe('reviewed');
    expect(getImportJob).toHaveBeenCalledWith('sess-1');

    // The routing-tree review payload — the exact fields the card binds to.
    const review = body.review;
    expect(review).toBeDefined();
    expect(Array.isArray(review.categories)).toBe(true);
    expect(review.categories[0]).toMatchObject({ category: 'photos' });
    // Per-folder routing tree with inherited-vs-explicit rules + owner.
    expect(Array.isArray(review.tree)).toBe(true);
    expect(review.tree[0]).toMatchObject({
      dir: 'alice',
      explicit: { owner: 'alice' },
      resolved: { owner: 'alice' },
    });
    // Owner picker source + disk-default seed.
    expect(review.boxUsers).toEqual(['alice', 'bob']);
    expect(review.defaultOwner).toBe('shared');
  });

  it('returns 404 for an unknown / forged / pruned job id', async () => {
    getImportJob.mockResolvedValue(null);

    const res = await GET(req('nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
