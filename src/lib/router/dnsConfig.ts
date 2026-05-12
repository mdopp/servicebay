/**
 * Router-side DNS configuration helpers (#249, D19-PR6).
 *
 * Currently only FritzBox via TR-064 — every other vendor falls back
 * to "show vendor-specific instructions" content in the probe action.
 * Adding new vendors is just a new function here + a new action
 * registration in `lib/diagnose/probes/routerDnsNotPointing.ts`.
 */

import { FritzBoxClient } from '@/lib/fritzbox/client';
import { fetchWithDigest } from '@/lib/fritzbox/digest';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

/** Outcome of a TR-064 call — shared by every router helper here so
 *  the probe-action layer can show the same status pill regardless of
 *  which call ran. `no_gateway` and `no_credentials` are user-fixable
 *  config gaps (Settings → Gateway); `failed` is everything else. */
export type RouterCallResult = {
  result: 'ok' | 'no_gateway' | 'no_credentials' | 'failed';
  detail?: string;
};

/**
 * Tell the FritzBox to hand out `targetIp` as the DHCP DNS server
 * (option 6) on the LAN — typically AdGuard's IP. Returns
 * `'ok' | 'no_gateway' | 'no_credentials' | 'failed'` so the action
 * handler can craft the right toast message.
 *
 * Uses the same TR-064 plumbing the gateway-status poll already does;
 * credentials come from `config.gateway.{host,username,password}`.
 */
export async function setFritzBoxDhcpDns(targetIp: string): Promise<RouterCallResult> {
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

/**
 * Force the FritzBox to drop its WAN connection and reconnect. The box
 * does this automatically within ~5–30s; on DSL/cable installs the
 * external IP usually changes, on FTTH/static-IP installs it doesn't.
 *
 * Why this matters: after `setFritzBoxDhcpDns` flips DHCP option 6 to
 * point at AdGuard, devices on existing leases keep their old DNS
 * until the lease renews — often hours on the FritzBox default of 24h.
 * A WAN reconnect doesn't directly refresh those leases, but on the
 * FritzBox it ALSO causes the box to re-publish its own DHCP server
 * state, which surfaces the new option-6 value to devices that poll
 * (mDNS-style discovery, "Renew" buttons, etc.) and forces the box's
 * own DNS resolver to re-read its configuration. In practice this is
 * the single quickest way to make new DNS settings take effect across
 * the LAN without rebooting client devices.
 *
 * Tries `WANIPConnection:1` first, falls back to `WANPPPConnection:1`
 * (DSL/PPPoE installs); whichever one the box exposes will accept the
 * `ForceTermination` action and return 200 with an empty body.
 *
 * Mirrors `setFritzBoxDhcpDns`'s credential resolution + result shape
 * so the calling probe-action handler doesn't need to know which
 * helper it invoked.
 */
export async function reconnectFritzBox(): Promise<RouterCallResult> {
  const config = await getConfig();
  const gateway = config.gateway;
  if (!gateway || gateway.type !== 'fritzbox') {
    return { result: 'no_gateway', detail: 'Gateway not configured as FritzBox in Settings → Gateway.' };
  }
  if (!gateway.username || !gateway.password) {
    return {
      result: 'no_credentials',
      detail: 'TR-064 needs FritzBox username + password (Settings → Gateway). Without them, click "Reconnect" in the FritzBox UI manually.',
    };
  }

  const port = gateway.ssl ? 49443 : 49000;
  const scheme = gateway.ssl ? 'https' : 'http';
  // ForceTermination lives on whichever WAN-connection service the box
  // actually publishes. The fixed paths below match every FritzBox
  // firmware in the wild — the service-discovery dance in
  // `FritzBoxClient.detectServiceType` is overkill for this one-shot
  // call. We just try IP first, PPP as fallback.
  const attempts: Array<{ serviceType: string; controlUrl: string }> = [
    { serviceType: 'urn:dslforum-org:service:WANIPConnection:1', controlUrl: '/upnp/control/wanipconnection1' },
    { serviceType: 'urn:dslforum-org:service:WANPPPConnection:1', controlUrl: '/upnp/control/wanpppconn1' },
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const url = `${scheme}://${gateway.host}:${port}${attempt.controlUrl}`;
      const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:ForceTermination xmlns:u="${attempt.serviceType}"/>
</s:Body>
</s:Envelope>`;
      const res = await fetchWithDigest(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SoapAction': `${attempt.serviceType}#ForceTermination`,
          },
          body,
          signal: AbortSignal.timeout(8_000),
        },
        { username: gateway.username, password: gateway.password },
      );
      if (res.ok) {
        logger.info('router:dnsConfig', `FritzBox ForceTermination accepted via ${attempt.serviceType}`);
        return { result: 'ok' };
      }
      const text = await res.text().catch(() => '');
      // 401 = bad credentials — same for both services, no point retrying.
      if (res.status === 401) {
        return {
          result: 'no_credentials',
          detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.',
        };
      }
      errors.push(`${attempt.serviceType}: HTTP ${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      errors.push(`${attempt.serviceType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  logger.warn('router:dnsConfig', `FritzBox reconnect failed: ${errors.join(' | ')}`);
  return {
    result: 'failed',
    detail: `FritzBox declined ForceTermination on both WAN services. Likely TR-064 is disabled (Settings → Home Network → FRITZ!Box Network → activate UPnP).`,
  };
}
