/**
 * POST /api/system/diagnose
 *
 * Thin wrapper around the lib-side orchestrator at
 * `src/lib/diagnose/runDiagnose.ts` (#600). Auth-gates the request,
 * parses the optional body, delegates, and wraps in NextResponse.
 * Body: `{ node?: string }` — defaults to "Local" if omitted.
 *
 * Re-exports the `DiagnoseProbe` type from the lib module so existing
 * importers of this route's types keep working.
 */

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { runDiagnose, type DiagnoseProbe } from '@/lib/diagnose/runDiagnose';

export type { DiagnoseProbe };

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;

  let nodeName = 'Local';
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.node === 'string' && body.node) nodeName = body.node;
  } catch {
    // ignore — keep default
  }

  const result = await runDiagnose(nodeName);
  return NextResponse.json(result);
}
