import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import { submitInstallRequest, InstallRequestError } from '@/lib/install/installRequests';

export const dynamic = 'force-dynamic';

/**
 * POST /api/install/requests (#2965) — an agent asks for an installation.
 *
 * This route **files a request**. It installs nothing, starts no job and
 * touches no service: it writes one row to the install-request store and parks
 * the decision as a durable approval the operator resolves in Settings →
 * Approvals. The agent CLI's `request-install` verb speaks this route and has
 * no other write anywhere.
 *
 * `tokenScope: 'propose'` — the ladder's independent "ask a human" tier
 * (apiScope.ts), the same tier a learning proposal uses. Deliberately NOT
 * `mutate`: nothing on the box changes here, and a request path reachable only
 * by a token that could already install would be pointless. Deliberately not
 * `read` either: a read-scoped token must stay unable to write anything at all,
 * including a request.
 *
 * The requesting principal comes from the authenticated session and NOTHING
 * else. A `requestedBy` in the body is ignored — that is the whole of the
 * "another principal cannot file it in your name" half of the binding.
 */
export const POST = withApiHandler({ tokenScope: 'propose' }, async ({ request, auth }) => {
  const principal = auth?.user;
  if (!principal) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  let body: { plan?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { plan?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const filed = await submitInstallRequest({
      plan: body.plan,
      reason: typeof body.reason === 'string' ? body.reason : '',
      requestedBy: principal,
    });
    return NextResponse.json({
      id: filed.id,
      status: filed.status,
      approvalId: filed.approvalId,
      installed: false,
      detail: 'filed for approval — NOTHING has been installed. ServiceBay installs it only if the operator approves.',
    });
  } catch (error) {
    if (error instanceof InstallRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('api:install:requests', 'filing an install request failed', error);
    return NextResponse.json({ error: 'internal server error' }, { status: 500 });
  }
});
