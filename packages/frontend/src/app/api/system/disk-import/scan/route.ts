import { NextResponse } from 'next/server';
import { z } from 'zod';
import { launchScan } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode, SHARE_GID } from '../wiring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Absolute `/dev/...` node of the partition to import. */
  device: z.string().min(1),
  node: z.string().optional(),
});

/**
 * POST — launch the disk-import WORKER CONTAINER over the device (#1949). The
 * heavy walk/hash/classify/dedup/plan runs in the worker's own resource-capped
 * container (never the control plane), which serves the lazy review tree app and
 * writes the compact status.json servicebay reads. Returns a `runId` immediately;
 * the tile opens the worker app and polls `GET ./status`.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      const { runId } = await launchScan({
        exec: makeExec(node),
        device: body.device,
        shareGid: SHARE_GID,
      });
      return NextResponse.json({ ok: true, runId });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:scan', status: 400, exposeMessage: true });
    }
  },
);
