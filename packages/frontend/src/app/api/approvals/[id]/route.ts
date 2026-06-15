import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getApproval } from '@/lib/approvals';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export const GET = withApiHandlerParams<undefined, undefined, { id: string }>(
  {},
  async ({ params }) => {
    try {
      const approval = await getApproval(decodeURIComponent(params.id));
      if (!approval) {
        return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
      }
      return NextResponse.json({ approval });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:approvals', `get ${params.id} failed`, error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
