/**
 * LAN-IP detection + reconciliation (#249, D19-PR9).
 *
 * ServiceBay's LAN IP feeds two places: AdGuard wildcard rewrites
 * (`*.home.arpa` → IP) and NPM proxy-host `forward_host` entries.
 * If the IP changes mid-life, both go stale.
 *
 * Install-time captures the IP via `ip route get 1.1.1.1` agent-side
 * (whichever interface holds the default route). Boot-time reconcile
 * (server.ts startup) re-runs the detection and updates AdGuard +
 * NPM if the IP differs from the stored value.
 *
 * Static-IP installs (the FCoS install-script default) won't see this
 * fire often — but the safety net catches manual NetworkManager edits,
 * NIC swaps, and OS upgrades.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

/** Probe the agent for ServiceBay's outbound LAN IP. */
export async function detectLanIp(node: string): Promise<string | null> {
  try {
    const agent = await agentManager.ensureAgent(node);
    const result = await agent.sendCommand(
      'exec',
      { command: "ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'" },
      { timeoutMs: 4000 },
    ) as { code?: number; stdout?: string };
    if (result.code !== 0) return null;
    const ip = (result.stdout ?? '').trim();
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Persist ServiceBay's LAN IP to config. Called at boot from server.ts
 * so the install-time value (and subsequent changes) actually land in
 * `config.reverseProxy.lanIp` — without this, the
 * `lan_ip_changed_since_install` and `router_dns_not_pointing` probes
 * stay permanently in the `info` "no install-time value recorded yet"
 * state. See #318.
 *
 *   - First call (no stored value): write current IP, no history entry.
 *   - Subsequent boots, IP unchanged: no-op.
 *   - IP changed: append the *previous* IP to history (with the time
 *     this run detected the change) so `recentChanges()` can flag
 *     drift, and update the stored value.
 *
 * Returns the persisted IP, or `null` when detection failed (in which
 * case nothing is written — leaves the previous value alone so a brief
 * detection blip doesn't drop a real install-time value).
 */
export async function reconcileLanIp(node: string): Promise<string | null> {
  const current = await detectLanIp(node);
  if (!current) return null;
  const config = await getConfig();
  const stored = config.reverseProxy?.lanIp;
  if (stored === current) return current;

  const history = [...(config.reverseProxy?.lanIpHistory ?? [])];
  if (stored && stored !== current) {
    history.push({ ip: stored, detectedAt: new Date().toISOString() });
  }
  await updateConfig({
    reverseProxy: {
      lanIp: current,
      lanIpHistory: history,
    },
  });
  if (!stored) {
    logger.info('lanIp', `Captured install-time LAN IP: ${current}`);
  } else {
    logger.info('lanIp', `LAN IP changed: ${stored} → ${current}`);
  }
  return current;
}

/** Format a yymmdd-cutoff for "the last N days." */
export function dateNDaysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/** Count how many distinct IPs appear in the history within the last
 *  `days` days. Used by the diagnose probe to decide info-vs-warn:
 *  more than 1 change in 30 days suggests the IP is unstable enough
 *  that the user should set a DHCP reservation. */
export function recentChanges(
  history: Array<{ ip: string; detectedAt: string }>,
  days: number,
): number {
  const cutoff = dateNDaysAgo(days).getTime();
  const recent = history.filter(e => Date.parse(e.detectedAt) >= cutoff);
  const distinct = new Set(recent.map(e => e.ip));
  return distinct.size > 0 ? distinct.size - 1 : 0; // changes = distinct count - 1
}
