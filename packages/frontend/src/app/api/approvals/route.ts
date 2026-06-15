import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { listApprovals, submitApproval } from '@/lib/approvals';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Action = z
  .object({
    move: z.object({ src: z.string(), dst: z.string() }).optional(),
    restart: z.string().optional(),
  })
  .strict();

const Body = z.object({
  service: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).optional(),
  on_approve: Action.optional(),
  on_reject: Action.optional(),
  node: z.string().optional(),
});

export const GET = withApiHandler(
  {},
  async () => {
    try {
      const approvals = await listApprovals();
      return NextResponse.json({ approvals });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:approvals', 'list failed', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);

export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body },
  async ({ body }) => {
    try {
      const approval = await submitApproval(body);
      return NextResponse.json({ approval }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:approvals', 'submit failed', error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
