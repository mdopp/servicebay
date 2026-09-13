import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import { withApiHandlerParams } from '@/lib/api/handler';
import { logTextForPrincipal } from '@/lib/api/principalRedaction';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/**
 * No scope is declared here. This route stays cookie/internal-only, and the
 * `read` a token principal needs to reach it is written down once, with every
 * other scopeless route, in `lib/api/tokenPrincipalRoutes.ts` (#2958). Until
 * that registry existed the only way to hold a bridged `read` session to
 * anything was a per-route `cookieScope`, added here and on the sibling stream
 * route by hand (#2943); the class gate replaced both.
 *
 * It matters because `podman logs` carries whatever an image dumped at first
 * run, admin passwords included — so the handler redacts for a token principal.
 * `auth` is populated for any cookie-borne request now, and the operator's own
 * session carries no `scopes`, so it is untouched and still sees plaintext.
 */
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { id: string }>(
  { query: Query },
  async ({ query, params, auth }) => {
  const check = ContainerId.safeParse(params.id);
  if (!check.success) {
    return NextResponse.json({ logs: 'invalid id' }, { status: 400 });
  }
  const id = check.data;
  const nodeName = query.node || 'Local';

  try {
    const agent = agentManager.getAgent(nodeName);
    if (!agent) {
        return NextResponse.json({ logs: 'Agent not found' }, { status: 404 });
    }

    const response = await agent.sendCommand('exec', {
        command: `podman logs --tail 2000 ${id}`
    });

    if (response) {
        if (response.code === 0) {
             return NextResponse.json({
               logs: logTextForPrincipal(auth, response.stdout || 'No logs found.'),
             });
        } else {
             return NextResponse.json({ logs: response.stderr || 'Error fetching logs' }, { status: 500 });
        }
    }

    return NextResponse.json({ logs: 'Unknown error' }, { status: 500 });
  } catch (error) {
    return apiError(error, { tag: 'api:containers:logs', status: 500 });
  }
});
