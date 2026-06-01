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
 * Build the DHCP DNS SOAP payload and credentials for FritzBox.
 * Extracted from setFritzBoxDhcpDns to reduce function size.
 */
function buildDhcpDnsPayload(
  targetIp: string,
  gateway: { host: string; username?: string; password?: string; ssl?: boolean },
): {
  url: string;
  body: string;
  auth: string;
} {
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
  return { url, body, auth };
}

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
    const { url, body, auth } = buildDhcpDnsPayload(targetIp, gateway);
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
 * Build WAN DNS SOAP payload and credentials for FritzBox.
 * Extracted from setFritzBoxWanDns to reduce function size.
 */
function buildWanDnsPayload(
  targetIp: string,
  gateway: { host: string; username?: string; password?: string; ssl?: boolean },
): {
  scheme: string;
  port: number;
  auth: string;
  attempts: Array<{ serviceType: string; controlUrl: string }>;
} {
  const scheme = gateway.ssl ? 'https' : 'http';
  const port = gateway.ssl ? 49443 : 49000;
  const auth = `Basic ${Buffer.from(`${gateway.username}:${gateway.password}`).toString('base64')}`;
  const attempts = [
    { serviceType: 'urn:dslforum-org:service:WANIPConnection:1', controlUrl: '/upnp/control/wanipconnection1' },
    { serviceType: 'urn:dslforum-org:service:WANPPPConnection:1', controlUrl: '/upnp/control/wanpppconn1' },
  ];
  return { scheme, port, auth, attempts };
}

/**
 * Build SOAP body for WAN DNS SetDNSServers call.
 */
function buildWanDnsSoapBody(targetIp: string, serviceType: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:SetDNSServers xmlns:u="${serviceType}">
<NewDNSServers>${targetIp}</NewDNSServers>
</u:SetDNSServers>
</s:Body>
</s:Envelope>`;
}

/**
 * Tell the FritzBox to use `targetIp` as its OWN upstream DNS resolver
 * — what shows up in the FritzBox UI under "Internet → Account
 * Information → DNS Server → Use other DNSv4 servers". Different from
 * `setFritzBoxDhcpDns`: that one changes what the FritzBox hands out
 * to LAN clients (DHCP option 6); this one changes what the FritzBox
 * itself queries for upstream resolution.
 *
 * Use case: the operator wants to keep the FritzBox as the DHCP DNS
 * for LAN clients (typical default, fewer client-side surprises) but
 * route the FritzBox's own resolver through AdGuard. Both setups —
 * "AdGuard as LAN DNS" and "FritzBox as LAN DNS, AdGuard as upstream" —
 * achieve household-wide AdGuard filtering; this helper lets a probe
 * action lock in the second.
 *
 * Tries `WANIPConnection:1` first, falls back to `WANPPPConnection:1`.
 * The FritzBox must be configured to allow override (UI: "Use other
 * DNSv4 servers" rather than "From provider") — otherwise the call
 * returns HTTP 401 / 501 and we surface that as `failed` with a
 * pointer to the UI toggle.
 */
export async function setFritzBoxWanDns(targetIp: string): Promise<RouterCallResult> {
  const config = await getConfig();
  const gateway = config.gateway;
  if (!gateway || gateway.type !== 'fritzbox') {
    return { result: 'no_gateway', detail: 'Gateway not configured as FritzBox in Settings → Gateway.' };
  }
  if (!gateway.username || !gateway.password) {
    return {
      result: 'no_credentials',
      detail: 'TR-064 needs FritzBox username + password (Settings → Gateway). Without them, set the upstream DNS manually in the FritzBox UI.',
    };
  }

  const { scheme, port, auth, attempts } = buildWanDnsPayload(targetIp, gateway);
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const url = `${scheme}://${gateway.host}:${port}${a.controlUrl}`;
      const body = buildWanDnsSoapBody(targetIp, a.serviceType);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `"${a.serviceType}#SetDNSServers"`,
          'Authorization': auth,
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        logger.info('router:dnsConfig', `FritzBox SetDNSServers (WAN upstream) accepted via ${a.serviceType}`);
        return { result: 'ok' };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        return {
          result: 'no_credentials',
          detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.',
        };
      }
      errors.push(`${a.serviceType}: HTTP ${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      errors.push(`${a.serviceType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  logger.warn('router:dnsConfig', `FritzBox SetDNSServers (WAN upstream) failed: ${errors.join(' | ')}`);
  return {
    result: 'failed',
    detail: 'FritzBox declined SetDNSServers on both WAN services. Most common cause: "Internet → Account Information → DNS Server" is set to "From provider" — switch it to "Use other DNSv4 servers" once and retry; subsequent TR-064 writes then succeed.',
  };
}

/**
 * Build SOAP payload for WAN ForceTermination call.
 */
function buildForceTerminationPayload(
  gateway: { host: string; username?: string; password?: string; ssl?: boolean },
): {
  port: number;
  scheme: string;
  attempts: Array<{ serviceType: string; controlUrl: string }>;
} {
  const port = gateway.ssl ? 49443 : 49000;
  const scheme = gateway.ssl ? 'https' : 'http';
  const attempts = [
    { serviceType: 'urn:dslforum-org:service:WANIPConnection:1', controlUrl: '/upnp/control/wanipconnection1' },
    { serviceType: 'urn:dslforum-org:service:WANPPPConnection:1', controlUrl: '/upnp/control/wanpppconn1' },
  ];
  return { port, scheme, attempts };
}

/**
 * Build SOAP body for ForceTermination call.
 */
function buildForceTerminationBody(serviceType: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:ForceTermination xmlns:u="${serviceType}"/>
</s:Body>
</s:Envelope>`;
}

/**
 * Try ForceTermination on each WAN service endpoint.
 * Extracted from reconnectFritzBox to reduce function size.
 */
async function waitForFritzBoxReconnect(
  gateway: { host: string; username?: string; password?: string; ssl?: boolean },
  port: number,
  scheme: string,
  attempts: Array<{ serviceType: string; controlUrl: string }>,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const url = `${scheme}://${gateway.host}:${port}${attempt.controlUrl}`;
      const body = buildForceTerminationBody(attempt.serviceType);
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
        return { ok: true, errors: [] };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        errors.push('401');
        break;
      }
      errors.push(`${attempt.serviceType}: HTTP ${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      errors.push(`${attempt.serviceType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, errors };
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

  const { port, scheme, attempts } = buildForceTerminationPayload(gateway);
  const { ok, errors } = await waitForFritzBoxReconnect(gateway, port, scheme, attempts);

  if (ok) return { result: 'ok' };

  if (errors[0] === '401') {
    return {
      result: 'no_credentials',
      detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.',
    };
  }
  logger.warn('router:dnsConfig', `FritzBox reconnect failed: ${errors.join(' | ')}`);
  return {
    result: 'failed',
    detail: `FritzBox declined ForceTermination on both WAN services. Likely TR-064 is disabled (Settings → Home Network → FRITZ!Box Network → activate UPnP).`,
  };
}
