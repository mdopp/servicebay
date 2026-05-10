/**
 * Router-side DNS configuration helpers (#249, D19-PR6).
 *
 * Currently only FritzBox via TR-064 — every other vendor falls back
 * to "show vendor-specific instructions" content in the probe action.
 * Adding new vendors is just a new function here + a new action
 * registration in `lib/diagnose/probes/routerDnsNotPointing.ts`.
 */

import { FritzBoxClient } from '@/lib/fritzbox/client';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * Tell the FritzBox to hand out `targetIp` as the DHCP DNS server
 * (option 6) on the LAN — typically AdGuard's IP. Returns
 * `'ok' | 'no_gateway' | 'no_credentials' | 'failed'` so the action
 * handler can craft the right toast message.
 *
 * Uses the same TR-064 plumbing the gateway-status poll already does;
 * credentials come from `config.gateway.{host,username,password}`.
 */
export async function setFritzBoxDhcpDns(targetIp: string): Promise<{
  result: 'ok' | 'no_gateway' | 'no_credentials' | 'failed';
  detail?: string;
}> {
  const config = await getConfig();
  const gateway = config.gateway;
  if (!gateway || gateway.type !== 'fritzbox') {
    return { result: 'no_gateway', detail: 'Gateway not configured as FritzBox in Settings → Gateway.' };
  }
  if (!gateway.username || !gateway.password) {
    return {
      result: 'no_credentials',
      detail: 'TR-064 needs FritzBox username + password (Settings → Gateway). Without them, manual router configuration is required.',
    };
  }

  const client = new FritzBoxClient({
    host: gateway.host,
    username: gateway.username,
    password: gateway.password,
  });

  try {
    // FritzBox's `LANHostConfigManagement.SetDNSServers` accepts a
    // comma-separated list; passing just our target IP makes it the
    // sole DHCP-handed DNS server. Devices on existing leases keep
    // their old DNS until the lease renews (typically a few hours
    // on the FritzBox default of 24h).
    //
    // Reflection access: FritzBoxClient doesn't expose soapRequest
    // publicly today; for the v1 we shell out to the same SOAP
    // endpoint via fetch. Once this stabilizes we can move it onto
    // the client class proper.
    const url = `${gateway.ssl ? 'https' : 'http'}://${gateway.host}:${gateway.ssl ? 49443 : 49000}/upnp/control/lanhostconfigmgm`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:SetDNSServers xmlns:u="urn:dslforum-org:service:LANHostConfigManagement:1">
<NewDNSServers>${targetIp}</NewDNSServers>
</u:SetDNSServers>
</s:Body>
</s:Envelope>`;

    const auth = `Basic ${Buffer.from(`${gateway.username}:${gateway.password}`).toString('base64')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"urn:dslforum-org:service:LANHostConfigManagement:1#SetDNSServers"',
        'Authorization': auth,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('router:dnsConfig', `TR-064 SetDNSServers HTTP ${res.status}: ${text.slice(0, 200)}`);
      return {
        result: 'failed',
        detail: `FritzBox returned HTTP ${res.status} — likely TR-064 is disabled (Settings → Home Network → FRITZ!Box Network → activate UPnP) or the credentials are wrong.`,
      };
    }
    // Touch the existing client so we know it's still reachable for
    // the next call — best-effort; ignore failures.
    void client.getStatus().catch(() => undefined);
    return { result: 'ok' };
  } catch (e) {
    return {
      result: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
