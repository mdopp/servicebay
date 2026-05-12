import { NextResponse } from 'next/server';
import dns from 'dns/promises';
import { getConfig } from '@/lib/config';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

interface DomainResult {
  domain: string;
  resolvesTo: string | null;
  matches: boolean;
  error?: string;
}

/**
 * POST /api/system/dns/verify
 * Body: `{ domains: string[] }`
 *
 * For each domain, do a public-resolver A-record lookup and report
 * whether it points at *this* server. "This server" is the union of:
 *   - FritzBox externalIP (the public IP a public domain should resolve to)
 *   - reverseProxy.lanIp (the LAN IP that lan-only domains might be configured for)
 *
 * Used by the install wizard's Done step to replace the static
 * "Configure DNS — point each subdomain at <SERVER-IP>" instruction
 * with a real check: if every domain already points here, the wizard
 * shows a green ✓ instead of dumping a list of A-record entries the
 * operator may have already created.
 *
 * Best-effort: a FritzBox lookup failure (no gateway, wrong creds,
 * timeout) returns `expectedIPs` containing only the LAN IP and the
 * results still come through — the per-domain match flag just
 * reflects what we know. The endpoint never throws on partial info.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { domains?: unknown };
    const domains = Array.isArray(body.domains)
      ? body.domains.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : [];
    if (domains.length === 0) {
      return NextResponse.json({ expectedIPs: [], results: [] });
    }

    const config = await getConfig();
    const expectedIPs: string[] = [];
    if (config.reverseProxy?.lanIp) expectedIPs.push(config.reverseProxy.lanIp);

    if (config.gateway?.host) {
      try {
        const fb = new FritzBoxClient({
          host: config.gateway.host,
          username: config.gateway.username,
          password: config.gateway.password,
        });
        const status = await fb.getStatus();
        if (status.externalIP) expectedIPs.push(status.externalIP);
      } catch { /* gateway unreachable — keep going with lanIp only */ }
    }

    const expectedSet = new Set(expectedIPs);
    const results: DomainResult[] = await Promise.all(
      domains.map(async (domain): Promise<DomainResult> => {
        try {
          const addresses = await dns.resolve4(domain);
          const resolved = addresses[0] ?? null;
          return {
            domain,
            resolvesTo: resolved,
            matches: resolved !== null && expectedSet.has(resolved),
          };
        } catch (e) {
          return {
            domain,
            resolvesTo: null,
            matches: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    return NextResponse.json({ expectedIPs, results });
  } catch (error) {
    return apiError(error, { tag: 'api:system:dns:verify', status: 500 });
  }
}
