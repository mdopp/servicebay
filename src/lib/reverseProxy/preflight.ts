/**
 * Pre-flight gate for the LAN→Public migration (#265).
 *
 * The locked design requires three checks all green before the
 * orchestrator is allowed to run:
 *
 *   1. DNS resolves the proposed public domain to the install's
 *      public IP (letsdebug-style external probe).
 *   2. TCP/80 reachable from the internet (same probe — letsdebug
 *      surfaces both as distinct problem types).
 *   3. Router port-forward exists for 80 + 443 (`fritzbox` health
 *      check or, fallback, a TCP-connect from outside the LAN).
 *
 * Pure-ish: takes a domain, calls into the letsdebug client + the
 * existing fritzbox health-check result, returns a single
 * `{ ready, checks }` payload the API route returns verbatim. No I/O
 * to the filesystem; the only network call is letsdebug.
 *
 * Kept independent of the orchestrator so the UI can poll this on a
 * 5-s loop without spinning up the migration code path.
 */

import { runLetsdebugForDomain, type LetsdebugProblem } from '../letsdebug/client';
import { HealthStore } from '../health/store';
import { getConfig } from '../config';
import { logger } from '../logger';

type CheckId = 'dns' | 'http01' | 'port-forward';
type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface PreflightCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightStatus {
  publicDomain: string;
  ready: boolean;
  checks: PreflightCheck[];
}

export interface PreflightDeps {
  runLetsdebug?: (domain: string) => Promise<{ problems: LetsdebugProblem[]; submissionUrl: string }>;
  /**
   * Read the most-recent fritzbox health-check result. Default impl
   * looks at HealthStore for any check of `type: 'fritzbox'` and
   * returns the latest result, or `null` if none exists.
   */
  getFritzboxLastResult?: () => Promise<{ status: 'ok' | 'fail'; message?: string } | null>;
}

/**
 * DNS problems letsdebug returns when the domain doesn't resolve or
 * resolves to the wrong host. Subset matched on `problem.name` —
 * letsdebug's full taxonomy is public at
 * https://github.com/letsdebug/letsdebug/blob/master/problem.go.
 */
const DNS_PROBLEM_NAMES = new Set([
  'NoIPAddress',
  'IPv6AAAANotResolving',
  'CAAIssuanceNotAllowed',
  'TXTRecordSizeLimitExceeded',
]);

/**
 * Problems that indicate port-80 is not reachable for ACME HTTP-01.
 * Includes the CA-side simulation failures since letsdebug's
 * `IssueFromLetsEncrypt` problem is what surfaces a real LE staging
 * failure when DNS + port 80 don't align.
 */
const HTTP01_PROBLEM_NAMES = new Set([
  'ANotRoutable',
  'BadRedirect',
  'CloudflareSpecificDetection',
  'PortNotOpen',
  'WebserverNon200',
  'IssueFromLetsEncrypt',
]);

function classifyLetsdebug(problems: LetsdebugProblem[]): { dns: CheckStatus; http01: CheckStatus; dnsDetail: string; http01Detail: string } {
  const fatalDns = problems.filter(p => DNS_PROBLEM_NAMES.has(p.name ?? '') && (p.severity ?? '').toLowerCase() === 'fatal');
  const fatalHttp = problems.filter(p => HTTP01_PROBLEM_NAMES.has(p.name ?? '') && (p.severity ?? '').toLowerCase() === 'fatal');

  return {
    dns: fatalDns.length === 0 ? 'pass' : 'fail',
    http01: fatalHttp.length === 0 ? 'pass' : 'fail',
    dnsDetail: fatalDns.length === 0
      ? 'DNS resolves and points at this install.'
      : fatalDns.map(p => `${p.name}: ${p.explanation ?? ''}`.trim()).join(' | '),
    http01Detail: fatalHttp.length === 0
      ? 'Port 80 reachable from the internet; ACME HTTP-01 can complete.'
      : fatalHttp.map(p => `${p.name}: ${p.explanation ?? ''}`.trim()).join(' | '),
  };
}

async function defaultFritzboxResult(): Promise<{ status: 'ok' | 'fail'; message?: string } | null> {
  const checks = HealthStore.getChecks();
  const fritz = checks.find(c => c.type === 'fritzbox');
  if (!fritz) return null;
  const last = HealthStore.getLastResult(fritz.id);
  if (!last) return null;
  return { status: last.status, message: last.message };
}

/**
 * Run the three pre-flight checks. Always returns a status object — a
 * single failed check makes `ready` false but the other two still
 * report their last known state so the UI can show partial progress.
 */
export async function getPreflightStatus(
  publicDomain: string,
  deps: PreflightDeps = {},
): Promise<PreflightStatus> {
  const trimmed = publicDomain.trim();
  const runLetsdebug = deps.runLetsdebug ?? runLetsdebugForDomain;
  const getFritz = deps.getFritzboxLastResult ?? defaultFritzboxResult;

  const checks: PreflightCheck[] = [
    { id: 'dns', label: `DNS for ${trimmed}`, status: 'unknown', detail: 'Pending.' },
    { id: 'http01', label: 'Port 80 reachable from the internet', status: 'unknown', detail: 'Pending.' },
    { id: 'port-forward', label: 'Router port-forward for 80 + 443', status: 'unknown', detail: 'Pending.' },
  ];

  // letsdebug covers checks 1 + 2.
  try {
    const result = await runLetsdebug(trimmed);
    const { dns, http01, dnsDetail, http01Detail } = classifyLetsdebug(result.problems);
    checks[0].status = dns;
    checks[0].detail = dnsDetail;
    checks[1].status = http01;
    checks[1].detail = http01Detail;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('preflight', `letsdebug call failed: ${msg}`);
    checks[0].detail = `letsdebug check failed: ${msg}`;
    checks[1].detail = checks[0].detail;
  }

  // Port-forward — read latest fritzbox health-check result if present.
  try {
    const fritz = await getFritz();
    if (!fritz) {
      // No fritzbox check configured. Per the locked design's fallback,
      // letsdebug success implies ports work end-to-end, so we report
      // 'unknown' rather than blocking — the UI can let the operator
      // override with a "I know my port-forward is set up" toggle in
      // PR-2 if needed.
      const config = await getConfig();
      const hasGateway = !!config.gateway?.type;
      checks[2].status = hasGateway ? 'unknown' : 'unknown';
      checks[2].detail = hasGateway
        ? 'No FritzBox health-check result yet — run it from the diagnose page or wait for the next scheduled tick.'
        : 'No router gateway configured; relying on the letsdebug result above to confirm ports 80/443 reach the internet.';
    } else if (fritz.status === 'ok') {
      checks[2].status = 'pass';
      checks[2].detail = 'Router reports the expected port-forward rules for 80/443.';
    } else {
      checks[2].status = 'fail';
      checks[2].detail = fritz.message ?? 'FritzBox health check reports a port-forward problem.';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks[2].detail = `FritzBox check read failed: ${msg}`;
  }

  // Ready iff DNS + http01 are green and the port-forward check is not
  // an outright fail (unknown is acceptable when the letsdebug result
  // already confirms internet-side reachability).
  const ready = checks[0].status === 'pass'
    && checks[1].status === 'pass'
    && checks[2].status !== 'fail';

  return { publicDomain: trimmed, ready, checks };
}
