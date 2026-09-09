import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { logTextForPrincipal } from '@/lib/api/principalRedaction';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/** Same class and same gate as the sibling `../route.ts` (#2943): a token
 *  principal — including a session bridged from a `read` token — gets the log
 *  body redacted, a cookie operator gets it verbatim. */
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { id: string }>(
  { query: Query, cookieScope: 'read' },
  async ({ query, params, auth }) => {
  const check = ContainerId.safeParse(params.id);
  if (!check.success) {
    return new NextResponse('invalid id', { status: 400 });
  }
  const id = check.data;
  const nodeName = query.node || 'Local';

  try {
    const agent = agentManager.getAgent(nodeName);
    if (!agent) {
        return new NextResponse('Agent not found', { status: 404 });
    }

    // Fetch last 2000 lines
    // We cannot easily stream via the current request-response model without blocking the agent
    // So we fetch a chunk.
    const response = await agent.sendCommand('exec', {
        command: `podman logs --tail 2000 ${id}`
    });

    if (response) {
        if (response.code === 0) {
             return new NextResponse(logTextForPrincipal(auth, response.stdout));
        } else {
             return new NextResponse(response.stderr || 'Error fetching logs', { status: 500 });
        }
    }

    return new NextResponse('Unknown error', { status: 500 });
  } catch (error) {
    // Log the real error server-side only; never leak the message/stack to
    // the HTTP client (js/stack-trace-exposure).
    console.error('Error streaming container logs:', error);
    return new NextResponse('internal server error', { status: 500 });
  }
});
