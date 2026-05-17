import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

/**
 * POST /api/system/lldap/probe
 * Body: { host: string, port: number }
 *
 * Tries to reach LLDAP's HTTP endpoint with a short timeout. Returns
 * `{ reachable: boolean }`. Used by the install wizard to wait for LLDAP
 * to come up before firing the group-seed call (LLDAP needs ~5–15 s on
 * cold start to initialize its SQLite DB and bind to its HTTP port).
 */
export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  try {
    const body = await request.json();
    const { host, port } = body as { host?: string; port?: number };
    if (typeof host !== 'string' || !host || typeof port !== 'number' || !port) {
      return NextResponse.json({ error: 'host and port are required' }, { status: 400 });
    }

    const url = `http://${host}:${port}/api/graphql`;
    try {
      // Posting a no-op GraphQL query exercises the full DB+auth path. LLDAP
      // returns 401 (unauthenticated) once it is fully ready — that is the
      // earliest reliable signal. The static root responds before the SQLite
      // schema is initialized and would cause us to seed too early.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(3000),
      });
      const reachable = res.status === 401 || res.ok;
      return NextResponse.json({ reachable, status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unreachable';
      return NextResponse.json({ reachable: false, error: msg });
    }
  } catch (error) {
    return apiError(error, { tag: 'api:system:lldap:probe', status: 500 });
  }
}
