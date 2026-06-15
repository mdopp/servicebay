import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { rejectApproval } from '@/lib/approvals';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  {},
  async ({ params }) => {
    const id = decodeURIComponent(params.id);
    try {
      const result = await rejectApproval(id);
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:approvals', `reject ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
