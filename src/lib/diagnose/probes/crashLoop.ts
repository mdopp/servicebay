/**
 * `crash_loop` probe actions (B15 / #241) — registers per-item handlers
 * that operate on the specific container the diagnose route surfaces
 * as restart-looping.
 *
 * The detection logic lives inline in the diagnose route (it walks
 * `podman ps` output and consults system uptime to suppress
 * just-booted false positives). This file only contributes the
 * actions that hang off each item:
 *   - `restart_pod` — `systemctl --user restart <name>.service`. Most
 *     restart loops resolve once the bind-mount permission, missing
 *     config, or port collision behind them is corrected; a manual
 *     restart kicks the unit out of its backoff window so the operator
 *     gets immediate feedback.
 *   - `show_recent_logs` — pulls the last 30 stderr lines via
 *     `podman logs --tail 30`. The diagnose card already shows three
 *     lines inline; this surfaces enough detail for an operator to
 *     spot the actual crash cause (missing env var, EPERM, OOM, …)
 *     without having to SSH into the box.
 */

import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'crash_loop';

// Matches a podman container name. Containers we manage are produced by
// quadlet from a kube YAML; podman normalizes names to lowercase
// alphanumerics + hyphens + underscores. Reject anything else so an
// itemId from a malformed payload can't be smuggled into the agent
// shell.
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function rejectUnsafeName(itemId?: string): ProbeActionResult | null {
  if (!itemId) {
    return { ok: false, message: 'No container name supplied.', refresh: false };
  }
  if (!SAFE_NAME.test(itemId)) {
    return { ok: false, message: `Container name "${itemId}" looks unsafe — refusing.`, refresh: false };
  }
  return null;
}

async function restartPod({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  const guard = rejectUnsafeName(itemId);
  if (guard) return guard;

  const agent = await agentManager.ensureAgent(node);
  // Container name → service unit. Quadlet generates `<name>.service`
  // for kube units; if the looping name is an infra-pod container that
  // doesn't have a unit, fall back to `podman restart <name>` so the
  // user still gets relief. Try the unit path first because it's the
  // canonical way to restart a managed service.
  const unitRes = await agent.sendCommand('exec', {
    command: `systemctl --user restart ${itemId}.service 2>&1`,
  }, { timeoutMs: 30_000 }) as { code?: number; stderr?: string; stdout?: string };

  if (unitRes.code === 0) {
    return {
      ok: true,
      message: `Restarted ${itemId}.service. Re-check in ~30 s; if it loops again the underlying cause is still present.`,
      refresh: true,
    };
  }

  // Non-zero from systemctl is most often "Unit not found" because
  // the looping container is a podman-direct one (e.g. an infra-pod
  // child container quadlet doesn't manage). Fall back to a direct
  // podman restart in that case.
  logger.info('diagnose:crash_loop', `systemctl restart ${itemId}.service returned ${unitRes.code}; falling back to podman restart`);
  const podmanRes = await agent.sendCommand('exec', {
    command: `podman restart ${itemId} 2>&1`,
  }, { timeoutMs: 30_000 }) as { code?: number; stderr?: string; stdout?: string };

  if (podmanRes.code === 0) {
    return {
      ok: true,
      message: `Restarted container ${itemId}. Re-check in ~30 s.`,
      refresh: true,
    };
  }
  return {
    ok: false,
    message: `Could not restart ${itemId}: ${(podmanRes.stderr ?? podmanRes.stdout ?? '').trim().slice(0, 200) || 'unknown error'}.`,
    refresh: false,
  };
}

async function showRecentLogs({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  const guard = rejectUnsafeName(itemId);
  if (guard) return guard;

  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
    command: `podman logs --tail 30 ${itemId} 2>&1`,
  }, { timeoutMs: 10_000 }) as { code?: number; stdout?: string };

  const log = (res.stdout ?? '').trim();
  if (!log) {
    return {
      ok: true,
      message: `No recent logs for ${itemId} — the container may have crashed before producing output. Try Settings → Services → ${itemId} → Logs for a wider time range.`,
      refresh: false,
    };
  }
  const lines = log.split('\n');
  return {
    ok: true,
    message: `${lines.length} log line${lines.length === 1 ? '' : 's'} from ${itemId} — open details below.`,
    details: log,
    refresh: false,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'restart_pod',
    label: 'Restart',
    description:
      'Restarts this container via systemctl (or podman restart for non-quadlet containers). Use after fixing the underlying cause (bind-mount perms, missing config, port collision) to break the backoff loop.',
  },
  restartPod,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_recent_logs',
    label: 'Show recent logs',
    description:
      'Fetches the last 30 stderr lines via `podman logs --tail 30` and renders them inline below the row — enough to identify the crash cause without SSH-ing into the box.',
  },
  showRecentLogs,
);
