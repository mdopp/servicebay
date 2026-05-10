import { NextResponse } from 'next/server';
import { z } from 'zod';
import { dispatchProbeAction } from '@/lib/diagnose/actions';
import '@/lib/diagnose/probes/register';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/diagnose/run-action
 *
 * Executes a fix-button click from the diagnose UI. The probe + action
 * id are looked up in the probe-action registry; the matching handler
 * runs server-side and returns a structured result the UI surfaces as
 * a toast plus an automatic re-run of the diagnose suite.
 *
 * Body: `{ probeId, actionId, node?, payload? }`.
 *  - `payload` is opaque to this layer; per-action handlers validate.
 *  - `node` defaults to "Local" if omitted.
 *
 * Response shape: `{ ok, message, refresh }`.
 */
const Body = z.object({
  probeId: z.string().min(1).max(64),
  actionId: z.string().min(1).max(64),
  node: z.string().min(1).max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Per-item dynamic actions (#251). Bounded length is just hygiene. */
  itemId: z.string().min(1).max(128).optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : 'Invalid request body' },
      { status: 400 },
    );
  }

  const result = await dispatchProbeAction({
    probeId: parsed.probeId,
    actionId: parsed.actionId,
    node: parsed.node ?? 'Local',
    payload: parsed.payload,
    itemId: parsed.itemId,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
