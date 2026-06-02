/**
 * `letsdebug` probe — runs letsdebug.net against `check.target` and
 * encodes the result into a CheckResult. Heavy / rate-limited
 * upstream; the continuous-sweep use case has been retired in favour
 * of `dns_routing`. This stays for the per-domain diagnose action.
 */

import { registerProbe } from './registry';
import { runLetsdebugForDomain } from '../../letsdebug/client';

registerProbe({
  type: 'letsdebug',
  async run(check) {
    let result;
    try {
      result = await runLetsdebugForDomain(check.target);
    } catch (e) {
      return {
        status: 'fail',
        message: `letsdebug error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (result.problems.length === 0) {
      return { status: 'ok', message: '' };
    }
    const hasFatal = result.problems.some(p => (p.severity || '').toLowerCase() === 'fatal');
    return {
      status: hasFatal ? 'fail' : 'ok',
      payload: {
        problems: result.problems,
        submissionUrl: result.submissionUrl,
      },
    };
  },
});
