import { NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/lib/config';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Per-request actions for the family portal access-request flow
 * (#242 follow-up).
 *
 *   PATCH  — mark a pending request resolved (admin clicked "create
 *            user" or "ignore").
 *   DELETE — drop the request entirely. Used for spam cleanup.
 *
 * Both endpoints require a session — proxy.ts only allows
 * `/api/system/access-requests` for POST publicly; PATCH and DELETE
 * fall through the existing session check, and withApiHandlerParams
 * additionally re-validates the session (defense-in-depth per #596).
 */

type Params = { id: string };

export const PATCH = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const config = await getConfig();
    const requests = [...(config.accessRequests ?? [])];
    const idx = requests.findIndex(r => r.id === params.id);
    if (idx < 0) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }
    requests[idx] = {
      ...requests[idx],
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    };
    await saveConfig({ ...config, accessRequests: requests });
    return NextResponse.json({ ok: true });
  },
);

export const DELETE = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const config = await getConfig();
    const requests = (config.accessRequests ?? []).filter(r => r.id !== params.id);
    await saveConfig({ ...config, accessRequests: requests });
    return NextResponse.json({ ok: true });
  },
);
