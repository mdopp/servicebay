/**
 * Per-pod actions for the `pods` probe + an `enable_socket` action
 * for the `podman` engine probe.
 *
 * The pods probe surfaces every pod whose status isn't `Running`.
 * Most live failure modes belong to specific containers (covered by
 * crash_loop) but a pod can also be `Created` or `Exited` as a whole
 * — usually after a manual `podman pod stop`. The `start_pod` action
 * is the right answer there.
 *
 * The podman engine probe fails when `podman info` doesn't return —
 * the most common cause on a fresh user-space install is the
 * `podman.socket` user unit not being enabled. The `enable_socket`
 * action runs the canonical fix.
 */

import { agentManager } from '@/lib/agent/manager';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function rejectUnsafeName(itemId?: string): ProbeActionResult | null {
  if (!itemId) return { ok: false, message: 'No pod name supplied.', refresh: false };
  if (!SAFE_NAME.test(itemId)) return { ok: false, message: `Pod name "${itemId}" looks unsafe — refusing.`, refresh: false };
  return null;
}

async function startPod({ node, itemId }: { node: string; itemId?: string }): Promise<ProbeActionResult> {
  const guard = rejectUnsafeName(itemId);
  if (guard) return guard;
  const agent = await agentManager.ensureAgent(node);
  // Quadlet-managed pods come up via `<name>.service` (a generated
  // systemd unit). Try the unit path first because that re-applies
  // restart policy + dependencies; fall back to direct `podman pod
  // start` for hand-managed pods.
  const unitRes = await agent.sendCommand('exec', {
    command: `systemctl --user start ${itemId}.service 2>&1`,
  }, { timeoutMs: 30_000 }) as { code?: number; stderr?: string; stdout?: string };
  if (unitRes.code === 0) {
    return {
      ok: true,
      message: `Started ${itemId}.service. Re-check in ~30 s; if it stops again the pod's containers may be in a restart loop.`,
      refresh: true,
    };
  }
  const podmanRes = await agent.sendCommand('exec', {
    command: `podman pod start ${itemId} 2>&1`,
  }, { timeoutMs: 30_000 }) as { code?: number; stderr?: string; stdout?: string };
  if (podmanRes.code === 0) {
    return { ok: true, message: `Started pod ${itemId}.`, refresh: true };
  }
  return {
    ok: false,
    message: `Could not start ${itemId}: ${(podmanRes.stderr ?? podmanRes.stdout ?? '').trim().slice(0, 200) || 'unknown error'}.`,
    refresh: false,
  };
}

async function enablePodmanSocket({ node }: { node: string }): Promise<ProbeActionResult> {
  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
    command: 'systemctl --user enable --now podman.socket 2>&1',
  }, { timeoutMs: 15_000 }) as { code?: number; stderr?: string; stdout?: string };
  if (res.code === 0) {
    return {
      ok: true,
      message: 'podman.socket enabled and started. Re-running diagnose…',
      refresh: true,
    };
  }
  return {
    ok: false,
    message: `Could not enable podman.socket: ${(res.stderr ?? res.stdout ?? '').trim().slice(0, 200) || 'unknown error'}. SSH into the host to investigate.`,
    refresh: false,
  };
}

registerProbeAction(
  'pods',
  {
    id: 'start_pod',
    label: 'Start',
    description:
      'Starts the pod via systemctl (or `podman pod start` for non-quadlet pods). Use after a manual stop or a failed boot. If containers within the pod are crash-looping, the crash_loop probe surfaces them with their own actions.',
  },
  startPod,
);

registerProbeAction(
  'podman',
  {
    id: 'enable_socket',
    label: 'Enable podman socket',
    description:
      'Runs `systemctl --user enable --now podman.socket` on the node. The canonical fix when the diagnose engine probe says podman isn\'t responding — the daemon is fine, the user-space socket just isn\'t up.',
  },
  enablePodmanSocket,
);
