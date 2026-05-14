/**
 * `lan_ip_changed_since_install` probe — surfaces when ServiceBay's
 * current LAN IP differs from the install-time captured value, or
 * when the IP has changed multiple times in the last 30 days
 * (suggests DHCP renewal-induced drift, signaling the operator
 * should set up a reservation).
 *
 * Phase 3b of the diagnose / health-check rework (#484): this probe
 * is now a **thin reader** over the health-check subsystem. Detection
 * runs on a `lan_ip_drift`-type singleton check (5 min interval, see
 * `health/init.ts`) and the result is persisted to `HealthStore`.
 * Result persistence, scheduling, and the Phase 3a SSE broadcast all
 * live there — this file just reads the latest result back into the
 * diagnose narrative.
 */

import { HealthStore } from '@/lib/health/store';
import { LAN_IP_DRIFT_MESSAGE_PREFIX } from '@/lib/health/runner';

export interface LanIpProbeResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

const CHECK_ID = 'lan_ip_drift';

export async function checkLanIpChanged(): Promise<LanIpProbeResult> {
  const result = HealthStore.getLastResult(CHECK_ID);
  if (!result) {
    return {
      status: 'info',
      detail: 'Check has not run yet. Open Settings → Health to trigger it manually.',
    };
  }
  if (result.message && result.message.startsWith(LAN_IP_DRIFT_MESSAGE_PREFIX)) {
    try {
      const json = result.message.slice(LAN_IP_DRIFT_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed.status === 'string' && typeof parsed.detail === 'string') {
        return {
          status: parsed.status === 'ok' || parsed.status === 'warn' ? parsed.status : 'info',
          detail: parsed.detail,
          hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
        };
      }
    } catch {
      // fall through to fail-style rendering
    }
  }
  if (result.status === 'fail') {
    return {
      status: 'info',
      detail: `Check failed to run: ${result.message || 'unknown error'}`,
    };
  }
  return {
    status: 'info',
    detail: 'LAN IP drift check produced no actionable signal.',
  };
}
