import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startApply } from '@/lib/diskImport/service';
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
 * POST — start a background apply of a previously-scanned + reviewed plan and
 * return the `jobId` IMMEDIATELY (#1897). The copy/chown/upload over a large
 * plan far exceeds the HTTP timeout, so it runs detached and the card polls
 * `GET ./status?id=<jobId>` for live copy progress. The review gate is checked
 * SYNCHRONOUSLY before the job is kicked off: it requires both the `sessionId`
 * of a reviewed (not-yet-applied) plan AND an explicit `confirmed: true`, so no
 * unreviewed plan can ever write. Resumable (catalog-backed). Photos go to
 * Immich, the rest into file-share/data/.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      const { jobId } = await startApply({
        exec: makeExec(node),
        sessionId: body.sessionId,
        shareGid: SHARE_GID,
      });
      return NextResponse.json({ ok: true, jobId });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:apply', status: 400, exposeMessage: true });
    }
  },
);
