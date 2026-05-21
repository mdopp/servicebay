import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

const Body = z
  .object({
    nodeName: z.string().optional(),
    // Older callers used `node` instead of `nodeName`; accept both.
    node: z.string().optional(),
    reason: z.string().optional(),
  })
  .default({});

export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body },
  async ({ body }) => {
    const nodeName = body.nodeName || body.node;
    const reason = body.reason || 'manual';
    const config = await getConfig();
    const timeoutMs = (config.agent?.gracefulShutdownTimeout ?? 30) * 1000;

    try {
      if (nodeName) {
        await agentManager.restartAgent(nodeName, reason, timeoutMs);
      } else {
        await agentManager.restartAll(reason, timeoutMs);
      }
      return NextResponse.json({ success: true });
    } catch (error) {
      return NextResponse.json(
        { success: false, error: (error as Error).message },
        { status: 500 },
      );
    }
  },
);
