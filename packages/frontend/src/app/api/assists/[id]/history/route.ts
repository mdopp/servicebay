import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { readHistory, safeAssistId } from '@/lib/assists/editor';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// GET /api/assists/:id/history — the ordered edit history for an entry (#2221),
// oldest first. `[]` for an entry that has never been edited.
export const GET = withApiHandlerParams<undefined, undefined, { id: string }>(
  {},
  async ({ params }) => {
    const rawId = decodeURIComponent(params.id);
    const id = safeAssistId(rawId);
    if (!id) {
      return NextResponse.json({ error: `invalid assist id: ${rawId}` }, { status: 400 });
    }
    try {
      const history = await readHistory(id);
      return NextResponse.json({ id, history });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `history ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
