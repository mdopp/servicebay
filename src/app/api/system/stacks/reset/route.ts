import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
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
export async function POST(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { confirm, node: requestedNode, preserve: rawPreserve } = body as {
      confirm?: string;
      node?: string;
      preserve?: unknown;
    };

    if (confirm !== 'RESET') {
      return NextResponse.json(
        { error: "Confirmation required: pass {\"confirm\": \"RESET\"} in body" },
        { status: 400 }
      );
    }

    const result = await performStackReset({ node: requestedNode, preserve: rawPreserve });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof StackResetError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, { tag: 'api:system:stacks:reset', status: 500 });
  }
}
