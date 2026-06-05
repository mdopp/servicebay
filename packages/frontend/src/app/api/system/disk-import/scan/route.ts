import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scanDevice } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { catalogPath, makeExec, resolveNode } from '../wiring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Absolute `/dev/...` node of the partition to import. */
  device: z.string().min(1),
  node: z.string().optional(),
});

/**
 * POST — mount the device READ-ONLY, walk + classify + dedup it into a plan, and
 * return the review payload (per-category sizing, total, and unavoidable
 * `actions[]`) plus a `sessionId`. Writes NOTHING to the host: this is the review
 * step before the confirm + apply. The `sessionId` is the only thing that
 * authorises a later apply of this exact reviewed plan.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      const result = await scanDevice({
        exec: makeExec(node),
        device: body.device,
        catalogPath: catalogPath(),
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:scan', status: 400, exposeMessage: true });
    }
  },
);
