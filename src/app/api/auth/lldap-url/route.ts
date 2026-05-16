import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';

export async function GET() {
  try {
    const config = await getConfig();
    const hosts = config.reverseProxy?.hosts || [];

    // Discriminate by forwardPort, not service name: LLDAP_SUBDOMAIN
    // lives in the `auth` template alongside AUTHELIA_SUBDOMAIN, so
    // buildProxyHosts writes `service: 'auth'` on both — the
    // legacy `service === 'lldap'` match never hits on real installs.
    // See `lib/lldap/client.ts:getLldapUserDeepLink` for the same
    // fix + the regression context (#442 follow-up).
    let lldapPort: number | null = null;
    const lldapUrl = config.lldap?.url;
    if (lldapUrl) {
      try {
        const parsedPort = Number(new URL(lldapUrl).port);
        if (Number.isFinite(parsedPort) && parsedPort > 0) lldapPort = parsedPort;
      } catch {
        // malformed URL — fall through to service-name match
      }
    }
    const lldapHost = hosts.find(h =>
      h.created && (
        (lldapPort !== null && h.forwardPort === lldapPort)
        || h.service === 'lldap'
      ),
    );
    if (lldapHost) {
      const isPureLanDomain = /\.(home\.arpa|local)$/i.test(lldapHost.domain);
      const scheme = isPureLanDomain ? 'http' : 'https';
      return NextResponse.json({ url: `${scheme}://${lldapHost.domain}` });
    }

    return NextResponse.json({ url: null });
  } catch {
    return NextResponse.json({ url: null });
  }
}
