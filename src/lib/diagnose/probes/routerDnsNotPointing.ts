/**
 * `router_dns_not_pointing` probe — detects whether household devices
 * are actually using AdGuard as their DNS resolver. Without this
 * signal, LAN-domain mode (#249) silently fails — `vault.home.arpa`
 * fails to resolve on phones whose router hasn't been pointed at
 * AdGuard yet.
 *
 * Detection — layered, per the design conversation:
 *
 *   - **FritzBox TR-064 (when available)**: read DHCP option 6 via
 *     LANHostConfigManagement.GetDNSServers, compare to AdGuard's IP
 *     (= ServiceBay's lan-IP). Match → DNS handout is correct.
 *   - **AdGuard query log**: `/control/querylog` — if AdGuard has
 *     logged at least one query from a non-localhost client in the
 *     last N minutes, devices are using it. Catches non-FritzBox
 *     setups where TR-064 isn't available.
 *
 * Either signal positive → `ok`. Both negative → `warn` with three
 * registered actions:
 *   - `configure_fritzbox` — TR-064 SetDNSServers (only registered
 *     when gateway is FritzBox; on other routers the action is
 *     absent and only `show_instructions` + `verify_from_device`
 *     remain).
 *   - `verify_from_device` — browser-side fetch to `admin.<lan>`,
 *     wired in D19-PR7 (#276).
 *   - `dismiss` — operator says "I'll handle it manually," writes
 *     to a config-stored dismiss-list so the probe stops nagging
 *     for 30 days.
 */

import { getConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { reconnectFritzBox, setFritzBoxDhcpDns } from '@/lib/router/dnsConfig';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'router_dns_not_pointing';
const DISMISS_DAYS = 30;
const QUERYLOG_RECENT_MIN = 10;

export interface RouterDnsProbeResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

interface AdguardQueryLogEntry {
  client?: string;
  client_id?: string;
  T?: string; // timestamp ISO
}

/** Read AdGuard's recent query log for non-localhost clients. */
async function adguardSeesLanClients(adminUrl: string, username: string, password: string): Promise<boolean> {
  try {
    const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const cutoff = Date.now() - QUERYLOG_RECENT_MIN * 60 * 1000;
    const res = await fetch(`${adminUrl.replace(/\/$/, '')}/control/querylog?limit=200`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: AdguardQueryLogEntry[] };
    const data = body.data ?? [];
    for (const entry of data) {
      const ts = entry.T ? Date.parse(entry.T) : 0;
      if (ts < cutoff) continue;
      const client = entry.client ?? entry.client_id ?? '';
      if (!client) continue;
      if (client === '127.0.0.1' || client === '::1' || client === 'localhost') continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Read the FritzBox's DHCP DNS option-6 setting via TR-064. */
async function fritzBoxDhcpDns(host: string, username: string, password: string): Promise<string | null> {
  try {
    const url = `http://${host}:49000/upnp/control/lanhostconfigmgm`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:GetDNSServers xmlns:u="urn:dslforum-org:service:LANHostConfigManagement:1"/>
</s:Body>
</s:Envelope>`;
    const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"urn:dslforum-org:service:LANHostConfigManagement:1#GetDNSServers"',
        Authorization: auth,
      },
      body,
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = /<NewDNSServers>([^<]*)<\/NewDNSServers>/.exec(text);
    if (!m) return null;
    return m[1].trim() || null;
  } catch {
    return null;
  }
}

/** Resolve AdGuard's admin URL + credentials.
 *
 *  Prefers the dedicated `config.adguard` block written by AdGuard's
 *  post-deploy (via `/api/system/adguard/credentials`) — this is where
 *  current installs store creds. Falls back to the legacy
 *  `templateSettings.ADGUARD_ADMIN_PASSWORD` for installs that predate
 *  the credentials endpoint. Mirrors `findAdguardCreds()` in the portal
 *  provisioner so the probe sees the same creds the provisioner uses
 *  to write rewrites; previously this probe only read the legacy path,
 *  which left freshly-installed boxes (no `templateSettings` password)
 *  reporting "AdGuard credentials not configured" even though
 *  `config.adguard.password` was set, suppressing the query-log signal. */
async function adguardCreds(): Promise<{ url: string; username: string; password: string } | null> {
  const config = await getConfig();
  const direct = config.adguard;
  if (direct?.password) {
    return {
      url:
        direct.adminUrl ||
        `http://localhost:${config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083'}`,
      username: direct.username || 'admin',
      password: direct.password,
    };
  }
  const password = config.templateSettings?.ADGUARD_ADMIN_PASSWORD;
  const port = config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083';
  if (!password) return null;
  return { url: `http://localhost:${port}`, username: 'admin', password };
}

/** Top-level probe entry — returns the partial probe payload. */
export async function checkRouterDnsNotPointing(): Promise<RouterDnsProbeResult> {
  const config = await getConfig();
  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return {
      status: 'info',
      detail: 'No LAN IP recorded yet — install-time detection hasn\'t run. The router-DNS probe needs an IP to compare DHCP option-6 against.',
    };
  }

  // Check the dismiss-list — if the operator clicked "I'll handle it
  // manually" within the last 30 days, return `info` instead of `warn`
  // so the probe doesn't keep nagging.
  const dismissedAt = config.reverseProxy?.routerDnsDismissedAt;
  if (dismissedAt) {
    const ageMs = Date.now() - Date.parse(dismissedAt);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays >= 0 && ageDays < DISMISS_DAYS) {
      return {
        status: 'info',
        detail: `Router DNS check dismissed ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} ago — re-checks resume after ${DISMISS_DAYS}d.`,
      };
    }
  }

  // Signal A — AdGuard query-log heuristic.
  const adguard = await adguardCreds();
  let adguardOk = false;
  if (adguard) {
    adguardOk = await adguardSeesLanClients(adguard.url, adguard.username, adguard.password);
  }

  // Signal B — FritzBox DHCP option-6 (only when gateway is fritzbox).
  let fritzOk = false;
  let fritzDetail = '';
  if (config.gateway?.type === 'fritzbox' && config.gateway.username && config.gateway.password) {
    const dhcpDns = await fritzBoxDhcpDns(
      config.gateway.host,
      config.gateway.username,
      config.gateway.password,
    );
    if (dhcpDns) {
      fritzOk = dhcpDns.split(',').map(s => s.trim()).includes(lanIp);
      fritzDetail = `FritzBox hands out DNS servers: ${dhcpDns}`;
    }
  }

  if (adguardOk || fritzOk) {
    const which = fritzOk
      ? `FritzBox DHCP points at ServiceBay (${lanIp}).`
      : `AdGuard sees LAN clients in the last ${QUERYLOG_RECENT_MIN} min.`;
    return { status: 'ok', detail: `Router DNS routing is working — ${which}` };
  }

  // Both signals negative — surface the warn.
  const detailParts: string[] = [];
  if (config.gateway?.type === 'fritzbox') {
    detailParts.push(fritzDetail || 'FritzBox is reachable but DHCP DNS is not pointed at ServiceBay.');
  }
  if (adguard) {
    detailParts.push(`AdGuard hasn't seen any LAN client queries in the last ${QUERYLOG_RECENT_MIN} min — devices probably aren't using it as DNS yet.`);
  } else {
    detailParts.push('AdGuard credentials not configured; query-log signal unavailable.');
  }

  return {
    status: 'warn',
    detail: detailParts.join(' '),
    hint: 'Click below to set ServiceBay as your router\'s DHCP DNS automatically (FritzBox via TR-064), or open the manual instructions for your router.',
  };
}

// ─── Action handlers ────────────────────────────────────────────────────

async function configureFritzbox(): Promise<ProbeActionResult> {
  const config = await getConfig();
  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return { ok: false, message: 'No LAN IP recorded yet — re-run the install-time detection first.', refresh: false };
  }
  const result = await setFritzBoxDhcpDns(lanIp);
  if (result.result === 'ok') {
    return {
      ok: true,
      message: `✅ FritzBox DHCP DNS set to ${lanIp}. Devices will pick up the new server when their lease renews (usually within an hour; restart Wi-Fi for an immediate refresh).`,
      refresh: true,
    };
  }
  return {
    ok: false,
    message: result.detail ?? 'FritzBox configuration failed — check Settings → Gateway and try again, or use the manual instructions.',
    refresh: false,
  };
}

/** Action handler for `reconnect_fritzbox`. Issues a TR-064
 *  ForceTermination so the FritzBox drops + re-establishes its WAN
 *  link. Used after `configure_fritzbox` to push the new DHCP-DNS
 *  setting through more aggressively than waiting for lease renewal —
 *  the FritzBox's own DNS resolver re-reads config on reconnect, and
 *  devices that auto-renew on link-state changes pick up option 6
 *  immediately. Marked destructive because the WAN goes down for
 *  5–30 s and DSL users typically get a fresh public IP. */
async function reconnectFritzboxAction(): Promise<ProbeActionResult> {
  const result = await reconnectFritzBox();
  if (result.result === 'ok') {
    return {
      ok: true,
      message:
        '✅ FritzBox is reconnecting (typically 5–30 s). DSL users will get a fresh public IP; the dynamic-DNS poller will catch up on its next tick.',
      refresh: true,
    };
  }
  return {
    ok: false,
    message:
      result.detail ??
      'FritzBox reconnect failed — check Settings → Gateway, or trigger "Neu verbinden" in the FritzBox UI under Internet → Online-Monitor.',
    refresh: false,
  };
}

async function dismissProbe(): Promise<ProbeActionResult> {
  const config = await getConfig();
  await updateConfig({
    reverseProxy: {
      ...config.reverseProxy,
      routerDnsDismissedAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    message: `Dismissed for ${DISMISS_DAYS} days. Re-check by clicking "Run again" on the diagnose page after that.`,
    refresh: true,
  };
}

// Register actions. The `configure_fritzbox` action will return a
// "no_gateway" failure on non-FritzBox installs — for those operators,
// the `show_instructions` action is the meaningful path. We register
// both unconditionally; the UI can hide the FritzBox-only one once
// the diagnose route exposes the gateway type, but for v1 the
// "Configure on FritzBox" button is harmless on non-FritzBox installs
// (it just returns a clear error).
registerProbeAction(
  PROBE_ID,
  {
    id: 'configure_fritzbox',
    label: 'Configure on FritzBox',
    description:
      'Sets your FritzBox to hand out ServiceBay\'s IP as the DNS server (DHCP option 6) via TR-064. Devices pick it up on next lease renewal. Requires Settings → Gateway to have FritzBox username + password configured.',
  },
  configureFritzbox,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'reconnect_fritzbox',
    label: 'Reconnect FritzBox',
    description:
      'Forces the FritzBox to drop and re-establish its WAN connection via TR-064 ForceTermination. Useful right after "Configure on FritzBox" so the new DHCP DNS setting takes effect without waiting for client lease renewals. Causes a brief (5–30 s) internet outage; DSL users typically get a fresh public IP.',
    destructive: true,
  },
  reconnectFritzboxAction,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'verify_from_device',
    label: 'Verify from this device',
    description:
      'Tries to resolve the LAN domain from your current browser. If this device works, your router is using AdGuard for DNS; if not, this device specifically needs its DNS configured.',
  },
  // Special-cased browser-side handler in SelfDiagnoseSection.tsx
  // (D19-PR7). Server-side handler is a no-op — the UI never invokes
  // it because it intercepts `verify_from_device` actions before
  // calling the dispatcher.
  async () => ({
    ok: false,
    message: 'verify_from_device runs in the browser — please click the button instead of dispatching server-side.',
    refresh: false,
  }),
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'dismiss',
    label: 'I\'ll handle it manually',
    description: `Hides this probe for ${DISMISS_DAYS} days. Use when you've already pointed your router at ServiceBay's IP, or when you don't want this check to keep firing.`,
  },
  dismissProbe,
);

logger.debug(
  'diagnose:probes',
  `Registered ${PROBE_ID} actions: configure_fritzbox, reconnect_fritzbox, verify_from_device, dismiss`,
);
