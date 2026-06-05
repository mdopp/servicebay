import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyImportPlan } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode, SHARE_GID } from '../wiring';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** The token from a prior `scan` — REQUIRED. The review gate. */
  sessionId: z.string().min(1),
  /** Explicit confirmation of the reviewed plan — required before any write. */
  confirmed: z.literal(true),
  node: z.string().optional(),
});

/**
 * POST — apply a previously-scanned + reviewed plan to the host. The review gate:
 * it requires both the `sessionId` of a plan scanned in this process AND an
 * explicit `confirmed: true`, so no unreviewed plan can ever write. Resumable
 * (catalog-backed). Photos go to Immich, the rest into file-share/data/.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      const result = await applyImportPlan({
        exec: makeExec(node),
        sessionId: body.sessionId,
        shareGid: SHARE_GID,
      });
      return NextResponse.json({ ok: true, applied: result.applied, items: result.items });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:apply', status: 400, exposeMessage: true });
    }
  },
);
