// Diagnose fix-action contract — sb/no-raw-api-fetch sweep (#2745 follow-up).
// Backs the raw `fetch('/api/system/diagnose/run-action')` call site in
// `components/DiagnoseProbeList.tsx`.
//
// The route (packages/frontend/src/app/api/system/diagnose/run-action/route.ts)
// is a bare `NextResponse.json(result, { status: result.ok ? 200 : 400 })` —
// a probe-action *failure* is a normal, expected outcome (a fix button that
// didn't fix it) and comes back as a 400 carrying a real `{ ok: false,
// message, details? }` body the UI reads and renders inline. `rawApi` would
// throw on that 4xx and lose `details`, so this route gets its own thin
// wrapper (via `apiFetch`, so it still gets the one client-side 401 handler)
// that reads the body regardless of status instead of throwing.

import { z } from 'zod';
import { apiFetch } from './apiFetch';

const DiagnoseActionBodySchema = z
  .object({
    ok: z.boolean().optional(),
    message: z.string().optional(),
    details: z.string().optional(),
    refresh: z.boolean().optional(),
  })
  .passthrough();

export interface DiagnoseActionResult {
  ok: boolean;
  status: number;
  message?: string;
  details?: string;
  refresh?: boolean;
}

export interface DiagnoseActionRequest {
  probeId: string;
  actionId: string;
  node: string;
  itemId?: string;
  payload?: Record<string, string>;
}

/** POST /api/system/diagnose/run-action — never throws on a non-2xx status;
 *  the caller reads `.ok`/`.message`/`.details` the same way whether the
 *  action succeeded or failed. */
export async function runDiagnoseAction(request: DiagnoseActionRequest): Promise<DiagnoseActionResult> {
  const res = await apiFetch('/api/system/diagnose/run-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const raw: unknown = await res.json().catch(() => ({}));
  const parsed = DiagnoseActionBodySchema.safeParse(raw);
  const data = parsed.success ? parsed.data : {};
  return {
    ok: res.ok && data.ok !== false,
    status: res.status,
    message: data.message,
    details: data.details,
    refresh: data.refresh,
  };
}
