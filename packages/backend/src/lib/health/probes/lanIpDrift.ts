/**
 * `lan_ip_drift` probe — compares the currently-detected LAN IP
 * to the install-time value captured in config.reverseProxy.lanIp.
 * Encodes the diagnose row payload behind LAN_IP_DRIFT_MESSAGE_PREFIX.
 */

import { registerProbe } from './registry';
import { getConfig } from '../../config';
import { detectLanIp, recentChanges } from '../../lanIp';

export const LAN_IP_DRIFT_MESSAGE_PREFIX = 'lan_ip_drift:';

const RECENT_DAYS = 30;
const RECENT_THRESHOLD = 1;

registerProbe({
  type: 'lan_ip_drift',
  async run(check) {
    try {
      const config = await getConfig();
      const stored = config.reverseProxy?.lanIp;
      const node = check.nodeName ?? 'Local';
      const current = await detectLanIp(node);

      let payload: { status: 'ok' | 'warn' | 'info'; detail: string; hint?: string };
      if (!current) {
        payload = { status: 'info', detail: "Could not detect ServiceBay's LAN IP — `ip route get` returned no result." };
      } else if (!stored) {
        payload = { status: 'info', detail: `LAN IP is ${current}. No install-time value recorded yet.` };
      } else {
        const history = config.reverseProxy?.lanIpHistory ?? [];
        const changes = recentChanges(history, RECENT_DAYS);
        if (current === stored) {
          if (changes > RECENT_THRESHOLD) {
            payload = {
              status: 'warn',
              detail: `LAN IP is currently ${current}, matching install. But it has changed ${changes} times in the last ${RECENT_DAYS} days.`,
              hint: "Set up a DHCP reservation in your router so the IP doesn't drift — this avoids brief outages while AdGuard rewrites + NPM forward-hosts catch up.",
            };
          } else {
            payload = { status: 'ok', detail: `LAN IP ${current} matches the install-time value.` };
          }
        } else {
          payload = {
            status: 'warn',
            detail: `LAN IP is now ${current}, but install-time was ${stored}. AdGuard rewrites + NPM forward-hosts will be reconciled on next boot.`,
            hint: changes > RECENT_THRESHOLD
              ? `This is the ${changes + 1}-th change in the last ${RECENT_DAYS} days — set a DHCP reservation in your router to stop the drift.`
              : 'A one-off change is fine; ServiceBay reconciles automatically on the next boot.',
          };
        }
      }
      return { status: 'ok', message: `${LAN_IP_DRIFT_MESSAGE_PREFIX}${JSON.stringify(payload)}` };
    } catch (e) {
      return { status: 'fail', message: `lan_ip_drift error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
