/**
 * `lan_ip_changed_since_install` probe — surfaces when ServiceBay's
 * current LAN IP differs from the install-time captured value, or
 * when the IP has changed multiple times in the last 30 days
 * (suggests DHCP renewal-induced drift, signaling the operator
 * should set up a reservation).
 *
 * Detection is read-only — compares the stored `config.reverseProxy.lanIp`
 * to the current `detectLanIp()` result. Doesn't auto-reconcile; that's
 * the boot-time path (separate concern in server.ts).
 *
 * Action `set_dhcp_reservation` is FritzBox-only via TR-064 — wired
 * up alongside the router-DNS probe in D19-PR6 (#263). For now, the
 * probe registers no actions — surfacing the warning is enough.
 */

import { getConfig } from '@/lib/config';
import { detectLanIp, recentChanges } from '@/lib/lanIp';

export interface LanIpProbeResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

const RECENT_DAYS = 30;
const RECENT_THRESHOLD = 1; // > 1 change in 30 days → warn

export async function checkLanIpChanged(node: string): Promise<LanIpProbeResult> {
  const config = await getConfig();
  const stored = config.reverseProxy?.lanIp;
  const current = await detectLanIp(node);

  if (!current) {
    return {
      status: 'info',
      detail: 'Could not detect ServiceBay\'s LAN IP — `ip route get` returned no result.',
    };
  }

  if (!stored) {
    return {
      status: 'info',
      detail: `LAN IP is ${current}. No install-time value recorded yet.`,
    };
  }

  const history = config.reverseProxy?.lanIpHistory ?? [];
  const changes = recentChanges(history, RECENT_DAYS);

  if (current === stored) {
    if (changes > RECENT_THRESHOLD) {
      return {
        status: 'warn',
        detail: `LAN IP is currently ${current}, matching install. But it has changed ${changes} times in the last ${RECENT_DAYS} days.`,
        hint: 'Set up a DHCP reservation in your router so the IP doesn\'t drift — this avoids brief outages while AdGuard rewrites + NPM forward-hosts catch up.',
      };
    }
    return {
      status: 'ok',
      detail: `LAN IP ${current} matches the install-time value.`,
    };
  }

  // Mismatch — fired before the boot-time reconcile auto-updates.
  return {
    status: 'warn',
    detail: `LAN IP is now ${current}, but install-time was ${stored}. AdGuard rewrites + NPM forward-hosts will be reconciled on next boot.`,
    hint: changes > RECENT_THRESHOLD
      ? `This is the ${changes + 1}-th change in the last ${RECENT_DAYS} days — set a DHCP reservation in your router to stop the drift.`
      : 'A one-off change is fine; ServiceBay reconciles automatically on the next boot.',
  };
}
