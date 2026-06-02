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
 * Probes that carry a structured diagnose payload attach it to the
 * typed `CheckResult.payload` field (#1539); the dispatcher persists it
 * verbatim. The old `*_MESSAGE_PREFIX` JSON-in-`message` bridge is gone.
 */

import { CheckConfig, CheckResult } from './types';
import { HealthStore } from './store';
import { listNodes } from '../nodes';
import { getExecutor } from '../executor';
import { getProbe } from './probes/registry';
// Side-effect import: every probe file self-registers via registerProbe.
// Must run before the first CheckRunner.run dispatch.
import './probes';

export class CheckRunner {
  static async run(check: CheckConfig): Promise<CheckResult> {
    const start = Date.now();
    let status: 'ok' | 'fail' = 'fail';
    let message = '';
    let payload: unknown;

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
          if ('payload' in result) payload = result.payload;
        } else {
          status = 'ok';
          if ('message' in result && result.message) message = result.message;
          if ('payload' in result) payload = result.payload;
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
      ...(payload !== undefined ? { payload } : {}),
    };

    HealthStore.saveResult(result);
    return result;
  }
}
