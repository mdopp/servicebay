import { NextResponse } from 'next/server';

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
  try {
    const body = await request.json();
    const { host, port } = body as { host?: string; port?: number };
    if (typeof host !== 'string' || !host || typeof port !== 'number' || !port) {
      return NextResponse.json({ error: 'host and port are required' }, { status: 400 });
    }

    const url = `http://${host}:${port}/`;
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
      // LLDAP serves its login page on root once the HTTP listener is up.
      // Anything in the 2xx/3xx range counts as reachable.
      return NextResponse.json({ reachable: res.status < 400, status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unreachable';
      return NextResponse.json({ reachable: false, error: msg });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'probe failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
