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

// A service name anchors the move-action jail (`/mnt/data/stacks/<service>`),
// so it must be a single safe path segment — no separators, no `..` traversal
// — or the jail collapses to a system path (#2043). Mirrors the backend's
// `assertServiceName`; the backend re-checks regardless (this is the outer
// guard so a bad name 400s before it reaches the store).
const ServiceName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'service must be a single safe path segment')
  .refine(s => s !== '.' && s !== '..', 'service must be a single safe path segment');

const Body = z.object({
  service: ServiceName,
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
