/**
 * Reading the box's listener table (#3028).
 *
 * `hostPorts.ts` holds the parsing and the merge as pure functions; this asks
 * the node. `ss -tulpnH` is the primitive `manager.ts` already uses for the
 * per-service host-port mapping, so this is the same door, not a second one.
 *
 * Unprivileged on purpose: `ss` lists every listening socket regardless, and
 * only the PROCESS NAME of another user's socket is withheld. A port with an
 * unknown owner is still a port you cannot bind — which is the fact that
 * matters — and asking for sudo to put a nicer name on it would buy a
 * privilege for cosmetics.
 *
 * It reads `ServiceListing` directly rather than through the `ServiceManager`
 * facade: this module lives INSIDE `lib/services/`, where the facade rule does
 * not apply, and going through the facade would close a cycle
 * (deploy → hostPortsRun → ServiceManager → serviceLifecycle → deploy).
 */
import { getExecutor } from '@/lib/executor';
import { ServiceListing } from './serviceListing';
import { logger } from '@/lib/logger';
import { buildPortReport, parseSsLine, type PortReport } from './hostPorts';

const SS_TIMEOUT_MS = 15 * 1000;

export async function readHostPorts(nodeName: string): Promise<PortReport> {
  // `null` means the table could not be read — NOT that nothing is listening.
  // Collapsing the two would answer with the declared service ports alone,
  // which miss sshd, adguard and the control plane: a plausible answer missing
  // exactly the ports that caused the outages.
  let listening: ReturnType<typeof parseSsLine>[] | null = null;
  try {
    const res = await getExecutor(nodeName).execSafe(['ss', '-tulpnH'], { timeoutMs: SS_TIMEOUT_MS, check: false });
    if (res.code === 0) {
      listening = (res.stdout ?? '').split('\n').map(parseSsLine);
    } else {
      logger.warn('hostPorts', `ss exited ${res.code}: ${(res.stderr ?? '').trim().slice(0, 200)}`);
    }
  } catch (e) {
    logger.warn('hostPorts', `could not read the listener table: ${e instanceof Error ? e.message : String(e)}`);
  }

  let services: { name: string; ports?: { host?: string | number | null }[] }[] = [];
  try {
    services = await ServiceListing.listServices(nodeName);
  } catch (e) {
    logger.warn('hostPorts', `could not list services: ${e instanceof Error ? e.message : String(e)}`);
  }

  return buildPortReport(
    nodeName,
    listening === null ? null : listening.filter((l): l is NonNullable<typeof l> => l !== null),
    services,
  );
}
