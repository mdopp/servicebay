import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getActiveDomain } from '@/lib/mode';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/verify-lan-dns
 *
 * Per-device DNS verification target (#249, D19-PR7). Browsers on the
 * LAN fetch `http://admin.<lan-domain>/api/system/verify-lan-dns` from
 * the diagnose page's "Verify from this device" button — if the
 * request actually reaches ServiceBay, the calling device's DNS
 * is configured to use AdGuard (or an upstream resolver that
 * forwards to it).
 *
 * No auth, no state, returns a constant. Safe to expose with
 * `Access-Control-Allow-Origin: *` so the diagnose page can fetch
 * it from any origin (the user could be hitting the dashboard via
 * IP:port while verifying that home.arpa resolves).
 */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  return NextResponse.json(
    {
      ok: true,
      hostname: 'servicebay',
      activeDomain: getActiveDomain(config),
      lanIp: config.reverseProxy?.lanIp ?? null,
    },
    { headers: corsHeaders() },
  );
});
