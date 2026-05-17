import { NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/lib/config';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

/**
 * Per-request actions for the family portal access-request flow
 * (#242 follow-up).
 *
 *   PATCH  — mark a pending request resolved (admin clicked "create
 *            user" or "ignore"). Body: `{ status: 'resolved' }`.
 *   DELETE — drop the request entirely. Used for spam cleanup.
 *
 * Both endpoints require a session — proxy.ts only allows
 * `/api/system/access-requests` for POST publicly; PATCH and DELETE
 * fall through the existing session check.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  const { id } = await params;
  const config = await getConfig();
  const requests = [...(config.accessRequests ?? [])];
  const idx = requests.findIndex(r => r.id === id);
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
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  const { id } = await params;
  const config = await getConfig();
  const requests = (config.accessRequests ?? []).filter(r => r.id !== id);
  await saveConfig({ ...config, accessRequests: requests });
  return NextResponse.json({ ok: true });
}
