import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startScan } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { catalogPath, listBoxUsers, makeExec, resolveNode } from '../wiring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Absolute `/dev/...` node of the partition to import. */
  device: z.string().min(1),
  node: z.string().optional(),
});

/**
 * POST — start a background scan of the device (mount RO → walk → classify →
 * dedup → plan) and return a `jobId` IMMEDIATELY (#1897). The walk + per-file
 * hashing on a large disk far exceeds the HTTP/proxy timeout, so the work runs
 * detached and the card polls `GET ./status?id=<jobId>` for live phase + counts
 * and, once reviewed, the plan. Writes NOTHING to the host: this is the review
 * step before the confirm + apply. The `jobId` is the only thing that authorises
 * a later apply of this exact reviewed plan.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      // #1915: hand the engine the box-user list so a top-level source dir named
      // exactly like a user is pre-assigned that owner (shown + overridable in the
      // review tree), and so the review's Owner picker is driven by real users.
      const boxUsers = await listBoxUsers();
      const { jobId } = await startScan({
        exec: makeExec(node),
        device: body.device,
        catalogPath: catalogPath(),
        boxUsers,
      });
      return NextResponse.json({ ok: true, jobId });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:scan', status: 400, exposeMessage: true });
    }
  },
);
