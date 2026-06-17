import { NextResponse } from 'next/server';
import { z } from 'zod';
import { abortImportJob } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** The job id returned by `scan` / `apply`. */
  id: z.string().min(1),
});

/**
 * POST — abort/dismiss a disk-import job (#1943). The card's "Start over": flips
 * a stuck or unwanted session terminal so it stops re-attaching and the user can
 * immediately begin a fresh scan. This is the fix for a killed/orphaned scan that
 * sat at 'Starting…' forever (a dead worker is also self-reaped on read, but the
 * user shouldn't have to wait — this dismisses it now). Idempotent + no-op-safe:
 * an unknown id returns 404; an already-terminal session returns its phase.
 * Writes only the session store; never touches the imported host.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const result = await abortImportJob(body.id);
      if (!result) {
        return NextResponse.json({ ok: false, error: 'unknown job' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, phase: result.phase });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:abort', status: 400, exposeMessage: true });
    }
  },
);
