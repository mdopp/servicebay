/**
 * `lan_ip_changed_since_install` probe — surfaces when ServiceBay's
 * current LAN IP differs from the install-time captured value, or
 * when the IP has changed multiple times in the last 30 days
 * (suggests DHCP renewal-induced drift, signaling the operator
 * should set up a reservation).
 *
 * Phase 3b of the diagnose / health-check rework (#484): this probe
 * is now a **thin reader** over the health-check subsystem. Detection
 * runs on a `lan_ip_drift`-type singleton check (5 min interval, see
 * `health/init.ts`) and the result is persisted to `HealthStore`.
 * Result persistence, scheduling, and the Phase 3a SSE broadcast all
 * live there — this file just reads the latest result back into the
 * diagnose narrative.
 *
 * Actions registered here (#549):
 *
 *   - `reconcile_lan_ip` — re-runs the boot-time reconcile NOW
 *     (`reconcileLanIp` + `provisionPortalRouting`), so AdGuard
 *     rewrites point at the current IP without waiting for a restart.
 *
 *   - `show_fritzbox_reservation_instructions` — guided walkthrough
 *     for setting a DHCP reservation in the FritzBox UI (the actual
 *     UI checkbox, not a TR-064 call — AVM doesn't expose
 *     reservation-add as a documented SOAP action, so the honest
 *     thing is operator-guided instructions rather than a
 *     half-working auto-fix).
 */

import { HealthStore } from '@/lib/health/store';
import { LAN_IP_DRIFT_MESSAGE_PREFIX } from '@/lib/health/runner';
import { reconcileLanIp } from '@/lib/lanIp';
import { provisionPortalRouting } from '@/lib/portal/provisioner';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';
import { registerRefreshNow } from './refreshHealthCheck';

export interface LanIpProbeResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

const PROBE_ID = 'lan_ip_changed_since_install';
const CHECK_ID = 'lan_ip_drift';

registerRefreshNow(PROBE_ID, CHECK_ID, 'LAN IP drift');

export async function checkLanIpChanged(): Promise<LanIpProbeResult> {
  const result = HealthStore.getLastResult(CHECK_ID);
  if (!result) {
    return {
      status: 'info',
      detail: 'Check has not run yet. Open Settings → Health to trigger it manually.',
    };
  }
  if (result.message && result.message.startsWith(LAN_IP_DRIFT_MESSAGE_PREFIX)) {
    try {
      const json = result.message.slice(LAN_IP_DRIFT_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed.status === 'string' && typeof parsed.detail === 'string') {
        return {
          status: parsed.status === 'ok' || parsed.status === 'warn' ? parsed.status : 'info',
          detail: parsed.detail,
          hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
        };
      }
    } catch {
      // fall through to fail-style rendering
    }
  }
  if (result.status === 'fail') {
    return {
      status: 'info',
      detail: `Check failed to run: ${result.message || 'unknown error'}`,
    };
  }
  return {
    status: 'info',
    detail: 'LAN IP drift check produced no actionable signal.',
  };
}

// ─── Action handlers ────────────────────────────────────────────────────

/** Re-run the same reconcile + portal-provision flow `server.ts`
 *  does at boot — but on-demand, so the operator doesn't have to
 *  restart ServiceBay to pick up an IP drift. Updates
 *  `config.reverseProxy.lanIp` (+ history entry for the previous
 *  value) and re-runs `provisionPortalRouting()` to refresh AdGuard
 *  rewrites against the new IP.
 *
 *  Best-effort: a provisioner failure surfaces in the message but
 *  doesn't roll back the config update (the new IP is already
 *  detectably-correct; AdGuard rewrites can be reprovisioned
 *  separately via `adguard_rewrites_missing`). */
async function reconcileLanIpAction({ node }: { node: string }): Promise<ProbeActionResult> {
  try {
    const newIp = await reconcileLanIp(node);
    if (!newIp) {
      return {
        ok: false,
        message: 'Could not detect ServiceBay\'s LAN IP. `ip route get` returned nothing — check the host\'s network configuration.',
        refresh: false,
      };
    }
    let provisionDetail: string | undefined;
    try {
      const provision = await provisionPortalRouting();
      provisionDetail = provision.detail;
      if (!provision.ok) {
        return {
          ok: false,
          message: `LAN IP updated to ${newIp}, but the AdGuard rewrite reprovision reported errors. See details below.`,
          details: provision.detail,
          refresh: true,
        };
      }
    } catch (e) {
      logger.warn('diagnose:lan_ip_changed', `reconcile: provisionPortalRouting threw: ${e instanceof Error ? e.message : String(e)}`);
      provisionDetail = `Portal-provisioner threw: ${e instanceof Error ? e.message : String(e)}. Run "Reprovision" on the adguard_rewrites_missing probe to retry.`;
      // Don't fail the action — the config update succeeded.
    }
    return {
      ok: true,
      message: `✅ LAN IP reconciled to ${newIp}. AdGuard rewrites updated against the new IP.`,
      details: provisionDetail,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

/** Operator-guided walkthrough for setting a DHCP reservation in the
 *  FritzBox UI. We deliberately don't auto-fix this via TR-064:
 *  AVM doesn't expose `AddDHCPReservation` as a documented SOAP
 *  action, and the closest unofficial paths (writing to
 *  `LANHostConfigManagement` reserved-host lists) are firmware-
 *  version-fragile. Manual UI is reliable; instructions are short.
 *
 *  For non-FritzBox routers, the instructions are vendor-neutral:
 *  "look for 'DHCP reservation' or 'static lease' in your router's
 *  admin UI". */
async function showFritzboxReservationInstructions(): Promise<ProbeActionResult> {
  const config = await getConfig();
  const isFritz = config.gateway?.type === 'fritzbox';
  const lanIp = config.reverseProxy?.lanIp ?? '<your-server-ip>';
  const gatewayUrl = config.gateway?.host ? `http://${config.gateway.host}` : 'your router\'s admin UI';

  const lines: string[] = [];
  if (isFritz) {
    lines.push(
      'Set a DHCP reservation on your FritzBox so the IP stays pinned across reboots:',
      '',
      `  1. Open ${gatewayUrl} (your FritzBox UI) and log in.`,
      `  2. Heimnetz → Netzwerk → Netzwerkverbindungen.`,
      `  3. Find the entry for this server (look for IP ${lanIp}; the name typically matches your hostname or "servicebay").`,
      `  4. Click the pencil icon at the end of the row.`,
      `  5. Tick "Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen".`,
      `  6. Click "OK".`,
      '',
      `That binds ${lanIp} to this server's MAC address. Next time DHCP renews, you'll get the same IP back; ServiceBay's drift counter stops climbing.`,
      '',
      `(AVM doesn't expose reservation-add as a documented TR-064 action, so this step is manual in the UI. If you've already pinned it, the lan_ip_drift check will go quiet on its next run.)`,
    );
  } else {
    lines.push(
      'Set a DHCP reservation on your router so this server\'s IP stays pinned across reboots:',
      '',
      `  1. Open your router's admin UI.`,
      `  2. Look for "DHCP reservation", "Static lease", "DHCP Reservation" or similar (varies by vendor — TP-Link / ASUS / OpenWrt / pfSense each call it slightly differently).`,
      `  3. Bind this server's MAC address to ${lanIp}.`,
      `  4. Save / apply.`,
      '',
      `Next time DHCP renews, the server gets the same IP back. ServiceBay's drift counter stops climbing.`,
    );
  }

  return {
    ok: true,
    message: 'Instructions ready below.',
    details: lines.join('\n'),
    refresh: false,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reconcile_lan_ip',
    label: 'Reconcile now',
    description:
      'Re-runs the boot-time reconcile on-demand: updates ServiceBay\'s recorded LAN IP to the currently-detected one, appends the previous value to history, and reprovisions AdGuard rewrites so DNS resolves at the new IP. Use this when you\'ve confirmed the new IP is stable (one-off drift) and want to clear the warn without restarting ServiceBay.',
  },
  reconcileLanIpAction,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_fritzbox_reservation_instructions',
    label: 'Set DHCP reservation (instructions)',
    description:
      'Renders a step-by-step walkthrough for pinning this server\'s IP via a DHCP reservation in your router\'s admin UI. Use this when the IP has drifted more than once recently — the right fix is to stop it from drifting in the first place. FritzBox-specific instructions when the gateway is configured as FritzBox; vendor-neutral otherwise.',
  },
  showFritzboxReservationInstructions,
);

logger.debug(
  'diagnose:probes',
  `Registered ${PROBE_ID} actions: refresh_now, reconcile_lan_ip, show_fritzbox_reservation_instructions`,
);
