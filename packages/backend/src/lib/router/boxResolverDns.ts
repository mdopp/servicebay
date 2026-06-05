/**
 * Re-point the box's OWN DNS resolver at AdGuard after install (#1675).
 *
 * The install bakes the box's NetworkManager DNS to the router + a public
 * fallback (e.g. `192.168.178.1;8.8.8.8`) so the box can resolve during
 * bootstrap, BEFORE AdGuard exists. But nothing ever re-points it once
 * AdGuard is up — so the box keeps a public fallback that resolves
 * `*.<publicDomain>` to the PUBLIC IP (the #1559 split-horizon trap, one
 * layer down on the box itself).
 *
 * This module runs the live fix that worked on 2026-06-04:
 *
 *   nmcli con mod <iface> ipv4.dns "127.0.0.1 <router>" ipv4.ignore-auto-dns yes
 *   nmcli device reapply <iface>
 *
 * → AdGuard (127.0.0.1) first, the router as fallback, NO public resolver.
 * Idempotent: re-running it just re-asserts the same setting. Best-effort —
 * a failure logs a warning and never fails the install (the box still
 * resolves via the baked router/public DNS; this only removes the public
 * fallback hazard).
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

export interface RepointBoxResolverResult {
  result: 'ok' | 'no_agent' | 'no_interface' | 'failed';
  detail: string;
}

/** Find the active NetworkManager connection name for the primary wired
 *  interface. We ask nmcli for the connection bound to a device whose
 *  type is `ethernet` and that is `connected` — that's `eno1` on the
 *  FCoS box, but discovering it avoids hard-coding the NIC name. */
const FIND_CONNECTION_CMD =
  "nmcli -t -f NAME,DEVICE,TYPE,STATE connection show --active | awk -F: '$3==\"802-3-ethernet\" && $4==\"activated\" {print $1; exit}'";

/** Router/fallback DNS to keep behind AdGuard. Prefer the configured
 *  FritzBox gateway host; fall back to deriving the .1 of the box's LAN
 *  IP (the typical home-router address). Never includes a public resolver. */
function fallbackResolver(gatewayHost: string | undefined, lanIp: string): string | null {
  if (gatewayHost && /^\d+\.\d+\.\d+\.\d+$/.test(gatewayHost)) return gatewayHost;
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(lanIp);
  return m ? `${m[1]}.1` : null;
}

/** Build the nmcli re-point command for `connName`: AdGuard (127.0.0.1)
 *  first, the router as fallback, `ignore-auto-dns yes` so DHCP-supplied
 *  resolvers (incl. any public fallback) are dropped — then reapply. */
function buildNmcliRepointCmd(connName: string, fallback: string | null): string {
  const dnsList = fallback ? `127.0.0.1 ${fallback}` : '127.0.0.1';
  const escaped = connName.replace(/'/g, "'\\''");
  return (
    `nmcli con mod '${escaped}' ipv4.dns '${dnsList}' ipv4.ignore-auto-dns yes && ` +
    `nmcli device reapply "$(nmcli -t -f GENERAL.DEVICES con show '${escaped}' | head -1)" 2>/dev/null || ` +
    `nmcli con up '${escaped}'`
  );
}

interface NmcliAgent {
  sendCommand: (action: string, params: Record<string, unknown>) => Promise<{ stdout?: string; stderr?: string; exit_code?: number }>;
}

/** Find the active wired connection, run the re-point, and classify the
 *  result. Separated from the config/agent setup so the public entry stays
 *  under the complexity ceiling. */
async function runNmcliRepoint(agent: NmcliAgent, fallback: string | null): Promise<RepointBoxResolverResult> {
  const find = await agent.sendCommand('exec', { command: FIND_CONNECTION_CMD });
  const connName = (find.stdout || '').trim().split('\n')[0]?.trim();
  if (!connName) {
    return { result: 'no_interface', detail: 'No active wired NetworkManager connection found — left the resolver untouched.' };
  }
  const res = await agent.sendCommand('exec', { command: buildNmcliRepointCmd(connName, fallback) });
  const exitCode = typeof res.exit_code === 'number' ? res.exit_code : 0;
  if (exitCode !== 0) {
    const stderr = (res.stderr || res.stdout || '').slice(0, 200);
    return { result: 'failed', detail: `nmcli re-point exited ${exitCode}: ${stderr}` };
  }
  logger.info('router:boxResolverDns', `Re-pointed ${connName} DNS to AdGuard (127.0.0.1) + fallback ${fallback ?? 'none'}; ignore-auto-dns on.`);
  const suffix = fallback ? `, fallback ${fallback}` : '';
  return { result: 'ok', detail: `Box resolver re-pointed at AdGuard (127.0.0.1)${suffix}, no public DNS.` };
}

/** Run the nmcli re-point on the box. `node` is the install node name
 *  (defaults to the local node). */
export async function repointBoxResolverToAdguard(node: string = 'Local'): Promise<RepointBoxResolverResult> {
  const config = await getConfig();
  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return { result: 'failed', detail: 'No LAN IP recorded — cannot derive the router fallback resolver.' };
  }
  const fallback = fallbackResolver(config.gateway?.host, lanIp);

  let agent: NmcliAgent;
  try {
    agent = (await agentManager.ensureAgent(node)) as unknown as NmcliAgent;
  } catch (e) {
    return { result: 'no_agent', detail: `Could not reach the node agent: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    return await runNmcliRepoint(agent, fallback);
  } catch (e) {
    return { result: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
