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
