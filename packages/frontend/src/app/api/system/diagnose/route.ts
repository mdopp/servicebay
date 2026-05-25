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
import { withApiHandler } from '@/lib/api/handler';
import { runDiagnose, type DiagnoseProbe } from '@/lib/diagnose/runDiagnose';

export type { DiagnoseProbe };

export const dynamic = 'force-dynamic';

export const POST = withApiHandler({}, async ({ request }) => {
  let nodeName = 'Local';
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.node === 'string' && body.node) nodeName = body.node;
  } catch {
    // ignore — keep default
  }

  const result = await runDiagnose(nodeName);
  return NextResponse.json(result);
});
