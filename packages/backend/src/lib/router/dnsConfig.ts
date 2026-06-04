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
 *  config gaps (Settings → Gateway); `unsupported` means the FritzBox
 *  model/firmware doesn't expose this TR-064 write action (so the
 *  operator must set DNS manually — NOT an error, see #1672); `failed`
 *  is everything else. */
export type RouterCallResult = {
  result: 'ok' | 'no_gateway' | 'no_credentials' | 'unsupported' | 'failed';
  detail?: string;
};

/** Parsed TR-064 SOAP fault — the `errorCode`/`errorDescription` AVM
 *  returns inside a `<s:Fault>` body. */
export interface SoapFault {
  errorCode: number | null;
  errorDescription: string;
}

/** Extract the UPnP `errorCode` + `errorDescription` from a TR-064 SOAP
 *  fault body. FritzBox returns these inside
 *  `<s:Fault><detail><UPnPError><errorCode>…`. Returns null when the
 *  text isn't a recognisable SOAP fault (e.g. an HTML error page). */
export function parseSoapFault(text: string): SoapFault | null {
  if (!text || !/<(\w+:)?Fault[\s>]/i.test(text) && !/UPnPError/i.test(text)) return null;
  const codeMatch = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text);
  const descMatch = /<errorDescription>([^<]*)<\/errorDescription>/i.exec(text);
  const faultStringMatch = /<(?:\w+:)?faultstring>([^<]*)<\/(?:\w+:)?faultstring>/i.exec(text);
  const errorCode = codeMatch ? parseInt(codeMatch[1], 10) : null;
  const errorDescription = (descMatch?.[1] ?? faultStringMatch?.[1] ?? '').trim();
  if (errorCode === null && !errorDescription) return null;
  return { errorCode, errorDescription };
}

/** UPnP error codes that mean "this action isn't implemented on this
 *  device/firmware" rather than a transient failure or a bad request.
 *  401 = Invalid Action, 501 = Action Failed (AVM returns this for
 *  SetDNSServers on models that don't expose the write), 602 = Optional
 *  Action Not Implemented. On any of these we tell the operator to set
 *  DNS manually and treat that as success — the write path simply isn't
 *  available on their box (#1672). */
const UNSUPPORTED_UPNP_CODES = new Set([401, 501, 602]);

/** Decide whether an HTTP status + body from a TR-064 write means the
 *  action is *unsupported* on this FritzBox (operator must set DNS by
 *  hand — not an error), returning a structured result, or a real
 *  failure with the actual SOAP fault surfaced. Shared by the DHCP and
 *  WAN write helpers so both give the same actionable message. */
export function classifyTr064WriteFailure(status: number, body: string, manualHint: string): RouterCallResult {
  const fault = parseSoapFault(body);
  // A bare HTTP 401 with no SOAP fault = credentials rejected at the
  // transport layer (not an "Invalid Action" UPnP fault).
  if (status === 401 && !fault) {
    return { result: 'no_credentials', detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.' };
  }
  if (fault && fault.errorCode !== null && UNSUPPORTED_UPNP_CODES.has(fault.errorCode)) {
    return {
      result: 'unsupported',
      detail: `This FritzBox doesn't support setting DNS over TR-064 (UPnP ${fault.errorCode}${fault.errorDescription ? ` — ${fault.errorDescription}` : ''}). ${manualHint} Once DNS is set, ServiceBay verifies it via the LAN resolution path, so a manual setup reads green.`,
    };
  }
  const faultDetail = fault
    ? ` SOAP fault: ${fault.errorCode ?? '?'}${fault.errorDescription ? ` ${fault.errorDescription}` : ''}.`
    : '';
  return {
    result: 'failed',
    detail: `FritzBox declined the DNS write (HTTP ${status}).${faultDetail} ${manualHint}`,
  };
}

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
      return classifyTr064WriteFailure(
        res.status,
        text,
        `Set the DHCP DNS server to ${targetIp} manually in the FritzBox UI (Home Network → Network → Network Settings → IPv4 Addresses → DHCP server → Local DNS server).`,
      );
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
/** Outcome of the per-WAN-service write loop: `ok`/`no_credentials` are
 *  terminal; otherwise the last HTTP status + body are carried out so the
 *  caller can classify unsupported-vs-failed once both services are tried. */
interface WanWriteAttemptOutcome {
  terminal: RouterCallResult | null;
  lastStatus: number;
  lastBody: string | null;
  errors: string[];
}

async function tryWanDnsWrites(
  targetIp: string,
  gateway: { host: string; username?: string; password?: string; ssl?: boolean },
): Promise<WanWriteAttemptOutcome> {
  const { scheme, port, auth, attempts } = buildWanDnsPayload(targetIp, gateway);
  const errors: string[] = [];
  let lastStatus = 0;
  let lastBody: string | null = null;
  for (const a of attempts) {
    try {
      const url = `${scheme}://${gateway.host}:${port}${a.controlUrl}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `"${a.serviceType}#SetDNSServers"`,
          'Authorization': auth,
        },
        body: buildWanDnsSoapBody(targetIp, a.serviceType),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        logger.info('router:dnsConfig', `FritzBox SetDNSServers (WAN upstream) accepted via ${a.serviceType}`);
        return { terminal: { result: 'ok' }, lastStatus, lastBody, errors };
      }
      const text = await res.text().catch(() => '');
      const fault = parseSoapFault(text);
      if (res.status === 401 && !fault) {
        return { terminal: { result: 'no_credentials', detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.' }, lastStatus, lastBody, errors };
      }
      lastStatus = res.status;
      lastBody = text;
      const faultStr = fault ? `${fault.errorCode ?? '?'} ${fault.errorDescription}` : text.slice(0, 120);
      errors.push(`${a.serviceType}: HTTP ${res.status} ${faultStr.trim()}`);
    } catch (e) {
      errors.push(`${a.serviceType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { terminal: null, lastStatus, lastBody, errors };
}

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

  const { terminal, lastStatus, lastBody, errors } = await tryWanDnsWrites(targetIp, gateway);
  if (terminal) return terminal;
  logger.warn('router:dnsConfig', `FritzBox SetDNSServers (WAN upstream) failed: ${errors.join(' | ')}`);
  if (lastBody !== null) {
    return classifyTr064WriteFailure(
      lastStatus,
      lastBody,
      'Set the upstream DNS manually in the FritzBox UI: Internet → Account Information → DNS Server → "Use other DNSv4 servers" → ' + targetIp + '. (If it\'s currently "From provider", switch it once and the manual value sticks.)',
    );
  }
  return {
    result: 'failed',
    detail: `FritzBox upstream-DNS write failed before it returned an HTTP status (${errors.join(' | ') || 'no response'}). Check that the FritzBox is reachable and TR-064/UPnP is enabled, or set the upstream DNS to ${targetIp} manually under Internet → Account Information → DNS Server.`,
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
      const fault = parseSoapFault(text);
      if (res.status === 401 && !fault) {
        errors.push('401');
        break;
      }
      errors.push(`${attempt.serviceType}: HTTP ${res.status} ${(fault ? `${fault.errorCode ?? '?'} ${fault.errorDescription}` : text.slice(0, 120)).trim()}`);
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
    detail: `FritzBox declined ForceTermination on both WAN services (${errors.join(' | ') || 'no response'}). Likely TR-064 is disabled (Settings → Home Network → FRITZ!Box Network → activate UPnP), or this model doesn't expose the reconnect action — trigger "Neu verbinden" in the FritzBox UI under Internet → Online-Monitor instead.`,
  };
}
