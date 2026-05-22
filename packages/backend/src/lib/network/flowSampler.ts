/**
 * Periodic socket-flow sampler (#505 / PR-1).
 *
 * Every `SAMPLE_INTERVAL_MS` the sampler asks each node for its current
 * TCP sockets (`socketFlows.collectHostSockets`), resolves them to
 * service↔service flows against the digital twin, and folds the result
 * into the rolling `flowsStore`. `getNodeGraph` reads that store to
 * render `observed` edges.
 *
 * Cost is one `ss` + one cgroup dump per node per tick — cheap, so the
 * 5-minute cadence is deliberately conservative (a flow has to be seen
 * by ≥2 ticks before it surfaces, which cuts one-off noise).
 */
import { listNodes } from '@/lib/nodes';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { collectHostSockets, resolveFlows } from './socketFlows';
import { recordFlows } from './flowsStore';

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** Let the agent finish its first inventory pass before the first scan. */
const SAMPLE_BOOT_DELAY_MS = 90 * 1000;

/**
 * Container-id → service name. Podman stamps `PODMAN_SYSTEMD_UNIT` on
 * every stack container (`<service>.service`); fall back to the pod
 * name. The twin's `containers` carry both.
 */
export function containerServiceMap(node: string): Map<string, string> {
  const map = new Map<string, string>();
  const twinNode = DigitalTwinStore.getInstance().getSnapshot().nodes?.[node];
  for (const c of twinNode?.containers ?? []) {
    const unit = c.labels?.['PODMAN_SYSTEMD_UNIT'];
    const svc = unit ? unit.replace(/\.service$/, '') : c.podName;
    if (svc && c.id) map.set(c.id, svc);
  }
  return map;
}

/** Sample one node and fold its flows into the store. */
export async function sampleNodeFlows(node: string): Promise<void> {
  const sockets = await collectHostSockets(node);
  if (sockets.established.length === 0) return;
  const containerToService = containerServiceMap(node);
  // No twin data yet (agent still syncing) — skip this tick rather than
  // record unresolvable flows.
  if (containerToService.size === 0) return;
  const flows = resolveFlows(sockets, containerToService);
  if (flows.length > 0) await recordFlows(flows);
}

async function sampleAllNodes(): Promise<void> {
  try {
    const nodes = await listNodes();
    for (const n of nodes) {
      try {
        await sampleNodeFlows(n.Name);
      } catch (e) {
        logger.warn('FlowSampler', `sample failed for ${n.Name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    logger.warn('FlowSampler', `node sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let started = false;

/** Start the periodic sampler. Idempotent — safe to call once at boot. */
export function startFlowSampler(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void sampleAllNodes(); }, SAMPLE_BOOT_DELAY_MS);
  setInterval(() => { void sampleAllNodes(); }, SAMPLE_INTERVAL_MS);
  logger.info('FlowSampler', `Started — sampling service↔service flows every ${SAMPLE_INTERVAL_MS / 60000} min.`);
}
