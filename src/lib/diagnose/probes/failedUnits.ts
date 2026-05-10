/**
 * Per-unit actions for the `failed_units` probe — registers the
 * `reset_failed` and `restart_unit` action handlers. The probe's
 * detection (parsing `systemctl --user --failed`) lives inline in
 * the diagnose route; this file only contributes the actions that
 * hang off each item.
 *
 * Two handlers because they're meaningfully different:
 *   - `reset_failed` — clears the unit's failed state without
 *     restarting. Useful when the underlying problem is already
 *     fixed and you just want the dashboard to stop nagging.
 *   - `restart_unit` — does the same `reset-failed` behind the
 *     scenes (`systemctl restart` of a failed Type=oneshot unit
 *     would otherwise stay failed) plus actually starts the unit
 *     again. This is the right answer when the unit failed at
 *     boot and the operator wants to retry it.
 */

import { agentManager } from '@/lib/agent/manager';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'failed_units';

// Allow alphanumerics, dot, dash, underscore, @ (template units),
// colon (rare but valid in some unit kinds). Reject everything else
// so a malformed payload can't smuggle shell metas into the agent.
const SAFE_UNIT = /^[a-z0-9][a-z0-9._@:-]{0,191}$/i;

function rejectUnsafe(unit?: string): ProbeActionResult | null {
  if (!unit) return { ok: false, message: 'No unit name supplied.', refresh: false };
  if (!SAFE_UNIT.test(unit)) return { ok: false, message: `Unit name "${unit}" looks unsafe — refusing.`, refresh: false };
  return null;
}

async function resetFailed({ node, itemId }: { node: string; itemId?: string }): Promise<ProbeActionResult> {
  const guard = rejectUnsafe(itemId);
  if (guard) return guard;
  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
    command: `systemctl --user reset-failed ${itemId} 2>&1`,
  }, { timeoutMs: 10_000 }) as { code?: number; stdout?: string; stderr?: string };
  if (res.code === 0) {
    return {
      ok: true,
      message: `Cleared failed state on ${itemId}. The unit's last-failure record is gone; status will reflect whatever it does next.`,
      refresh: true,
    };
  }
  return {
    ok: false,
    message: `reset-failed returned ${res.code}: ${(res.stderr ?? res.stdout ?? '').trim().slice(0, 200) || 'unknown error'}.`,
    refresh: false,
  };
}

async function restartUnit({ node, itemId }: { node: string; itemId?: string }): Promise<ProbeActionResult> {
  const guard = rejectUnsafe(itemId);
  if (guard) return guard;
  const agent = await agentManager.ensureAgent(node);
  // `systemctl restart` on a failed unit needs reset-failed first for
  // some unit kinds (Type=oneshot stays in failed state after a
  // straight restart). Doing both unconditionally is idempotent and
  // gets the operator the behavior they expect: "click Restart, unit
  // tries to come up, success or fresh failure".
  const res = await agent.sendCommand('exec', {
    command: `systemctl --user reset-failed ${itemId} 2>/dev/null; systemctl --user restart ${itemId} 2>&1`,
  }, { timeoutMs: 30_000 }) as { code?: number; stdout?: string; stderr?: string };
  if (res.code === 0) {
    return {
      ok: true,
      message: `Restarted ${itemId}. Re-check in ~10 s; if it fails again the underlying cause is still present.`,
      refresh: true,
    };
  }
  return {
    ok: false,
    message: `Restart failed: ${(res.stderr ?? res.stdout ?? '').trim().slice(0, 200) || 'unknown error'}.`,
    refresh: false,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reset_failed',
    label: 'Clear failed state',
    description:
      'Runs `systemctl --user reset-failed <unit>`. Clears the unit\'s last-failure record without restarting it. Use when the underlying cause is already fixed and you just want the dashboard to stop showing the failure.',
  },
  resetFailed,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'restart_unit',
    label: 'Restart',
    description:
      'Resets the failed state and runs `systemctl --user restart <unit>`. Use when the unit failed at boot and you want to retry it. If the underlying problem persists the unit will fail again.',
  },
  restartUnit,
);
