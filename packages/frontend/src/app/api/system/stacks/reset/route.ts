import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { performStackReset, StackResetError } from '@/lib/install/performStackReset';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/stacks/reset
 * Body: {
 *   confirm: 'RESET',
 *   node?: string,
 *   preserve?: ResetGroup[]   // omit = use DEFAULT_PRESERVE
 * }
 *
 * Wipes stack data so the install wizard can re-deploy. Granular per
 * #568 — the operator picks which groups to keep. The implementation
 * lives in `lib/install/performStackReset.ts` so the Factory Reset
 * endpoint (#623) can drive the same wipe.
 *
 * ServiceBay itself is intentionally not touched (Quadlet definition).
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = await request.json();
    const { confirm, node: requestedNode, preserve: rawPreserve, wipeImages } = body as {
      confirm?: string;
      node?: string;
      preserve?: unknown;
      wipeImages?: boolean;
    };

    if (confirm !== 'RESET') {
      return NextResponse.json(
        { error: "Confirmation required: pass {\"confirm\": \"RESET\"} in body" },
        { status: 400 }
      );
    }

    const result = await performStackReset({ node: requestedNode, preserve: rawPreserve, wipeImages: wipeImages === true });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof StackResetError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, { tag: 'api:system:stacks:reset', status: 500 });
  }
});
