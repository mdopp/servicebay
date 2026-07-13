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

// tokenScope:'read' (#2244) — a scoped Bearer token may fetch the generic
// pending-approval feed so an external consumer (Solaris Wartung chat) can
// render approval cards. Deny-by-default: no/insufficient-scope Bearer 401s;
// the cookie-session path is unchanged. The POST (submit) below deliberately
// stays cookie/internal-only (no tokenScope) — this issue only opens the read
// feed + the approve/reject verdict to tokens, not new-request submission.
export const GET = withApiHandler(
  { tokenScope: 'read' },
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
