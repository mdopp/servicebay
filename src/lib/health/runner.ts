/**
 * Health-check dispatcher (#592).
 *
 * The previous version was a 17-arm `switch (check.type)`. Each arm
 * has been lifted into its own file under `src/lib/health/probes/`
 * and registered via `registerProbe`. The dispatcher now just looks
 * the probe up, runs it, and uniformly wraps the result into a
 * `CheckResult` row for `HealthStore`.
 *
 * Adding a new check type is purely additive — drop a file under
 * `probes/`, add it to the barrel, no edits here.
 *
 * Message-prefix constants are re-exported from their probe modules
 * so existing diagnose readers keep importing `LETSDEBUG_MESSAGE_PREFIX`
 * etc. from this file unchanged.
 */

import { CheckConfig, CheckResult } from './types';
import { HealthStore } from './store';
import { listNodes } from '../nodes';
import { getExecutor } from '../executor';
import { getProbe } from './probes/registry';
// Side-effect import: every probe file self-registers via registerProbe.
// Must run before the first CheckRunner.run dispatch.
import './probes';

// Re-export the message-prefix discriminators from their probe homes
// so the diagnose-side readers that import them from `runner` keep
// working without touching their import paths.
export { LETSDEBUG_MESSAGE_PREFIX } from './probes/letsdebug';
export { LAN_IP_DRIFT_MESSAGE_PREFIX } from './probes/lanIpDrift';
export { NPM_AUTH_MESSAGE_PREFIX } from './probes/npmAuthProbe';
export { CERT_EXPIRY_MESSAGE_PREFIX } from './probes/certExpiry';
export { CERT_REQUEST_FAILURE_MESSAGE_PREFIX } from './probes/certRequestFailure';
export { DNS_ROUTING_MESSAGE_PREFIX } from './probes/dnsRouting';

export class CheckRunner {
  static async run(check: CheckConfig): Promise<CheckResult> {
    const start = Date.now();
    let status: 'ok' | 'fail' = 'fail';
    let message = '';

    let connection;
    if (check.nodeName && check.nodeName !== 'Local') {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === check.nodeName);
    }
    const executor = getExecutor(connection);

    const probe = getProbe(check.type);
    if (!probe) {
      message = `unknown check type "${check.type}"`;
    } else {
      try {
        const result = await probe.run(check, { executor });
        if (!result) {
          status = 'ok';
        } else if ('status' in result && result.status) {
          status = result.status;
          message = result.message ?? '';
        } else {
          status = 'ok';
          if ('message' in result && result.message) message = result.message;
        }
      } catch (e: unknown) {
        status = 'fail';
        message = e instanceof Error ? e.message : String(e);
      }
    }

    const latency = Date.now() - start;
    const result: CheckResult = {
      check_id: check.id,
      timestamp: new Date().toISOString(),
      status,
      latency,
      message,
    };

    HealthStore.saveResult(result);
    return result;
  }
}
