import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { submitApproval } from '@/lib/approvals';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  reason: z.string().min(1).max(2000),
  node: z.string().optional(),
});

/**
 * POST /api/services/[name]/removal-requests (#2994) — an agent ASKS for a
 * service to be removed. It removes nothing.
 *
 * The sibling of `/api/install/requests`: `propose` is the ladder's independent
 * "ask a human" tier, so a token that may not destroy may still put the
 * question. Approving it in Settings → Approvals re-dispatches `delete_service`
 * through the operator path — the same soft-delete (trash, restorable for seven
 * days) the destroy-tier tool performs, never a purge.
 *
 * Why this route exists at all: the mechanism already did. A token calling a
 * destroy-tier MCP tool parks exactly this approval (#2234, `mcp/server.ts`).
 * But #2990 removed the handbook's raw-`/mcp` fallback — correctly, it was
 * leaking tokens into argv — and in doing so it closed the only door an agent
 * had to this. A session told "the old one can go" then had nowhere to put
 * that, and improvised: on 2026-09-20 it redeployed the service it was meant to
 * replace with a placeholder image to free the port, and took the domain down.
 * The answer is a door, not a wider scope.
 *
 * The requesting principal comes from the session and nothing else, so one
 * agent cannot file a removal in another's name.
 */
export const POST = withApiHandlerParams<z.infer<typeof Body>, undefined, { name: string }>(
  { body: Body, tokenScope: 'propose' },
  async ({ body, params, auth }) => {
    const principal = auth?.user;
    if (!principal) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const name = check.data;
    const node = body.node || 'Local';

    // Refuse to file a request for something that does not exist: a pending
    // approval naming a service nobody can find is noise the operator has to
    // work out, and the agent learns nothing from it either. Through the
    // ServiceManager facade, not `serviceListing` directly — every route does
    // (`service-manager-single-mutation-path`).
    // A listing that FAILED is not an empty listing: treating them alike would
    // answer "nothing to remove" for every name the moment a node is
    // unreachable, and an agent would file nothing while believing it had
    // asked. We only claim absence when we actually enumerated.
    const listed = await ServiceManager.listServices(node).then(
      s => ({ ok: true as const, services: s }),
      () => ({ ok: false as const, services: [] }),
    );
    if (listed.ok && !listed.services.some(s => s.name === name)) {
      return NextResponse.json(
        { error: `No service named "${name}" on node "${node}" — nothing to remove. Check \`servicebay services\`.` },
        { status: 404 },
      );
    }

    try {
      const request = await submitApproval({
        service: name,
        title: `delete_service: ${name}`,
        description: `An agent (${principal}) asked for the service "${name}" to be removed.\n\nReason given: ${body.reason}\n\n`
          + 'Approving moves it to the trash (restorable for seven days via restore_trashed_service); it is not purged. '
          + 'The agent cannot approve its own request.',
        payload: { toolName: 'delete_service', args: { name, node }, caller: principal, reason: body.reason },
        on_approve: { mcp: { toolName: 'delete_service', args: { name, node } } },
        node,
      });
      return NextResponse.json({
        id: request.id,
        status: request.status,
        service: name,
        removed: false,
        detail: 'filed for approval — NOTHING has been removed. ServiceBay removes it only if the operator approves, '
          + 'and then only to the trash.',
      });
    } catch (error) {
      logger.error('api:services:removal-requests', `filing a removal request for ${name} failed`, error);
      return NextResponse.json({ error: 'internal server error' }, { status: 500 });
    }
  },
);
