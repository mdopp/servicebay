/**
 * `sso_verify` probe (#1455) — surfaces the end-to-end SSO verification
 * (#1453 `verifySso`) in the diagnose UI: the latest report's per-domain
 * pass/fail breakdown plus a one-click "Run SSO check" action.
 *
 * The probe is a *reader* in steady state: it shows the report persisted
 * by the post-install auto-run (#1454, `ssoVerifyStore`) so a LAN admin
 * sees the last result without re-spinning an ephemeral user on every
 * diagnose tick (which would be slow + create/delete a real LLDAP account
 * each cycle). The `run_now` action is the explicit, on-demand re-run —
 * it executes the full create→login→domain→admin-reject→delete spine,
 * persists the fresh report, and refreshes the diagnose view.
 *
 * Status mapping (probe-level):
 *   - no report yet                       → info  ("not run yet")
 *   - report.ok === true                  → ok
 *   - report skipped (auth not installed) → info
 *   - report.ok === false                 → fail  (something is broken)
 *
 * Per-domain rows come through `_items[]` so the UI colour-codes each
 * user/admin domain individually (the existing DiagnoseProbeList already
 * renders items with per-row status). The action carries no per-item
 * buttons — it's a single probe-level "re-run everything" click.
 */

import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '@/lib/diagnose/actions';
import { verifySso, type SsoVerifyReport, type SsoDomainResult, type SsoStepResult } from '@/lib/diagnose/ssoVerify';
import { loadSsoVerifyReport, saveSsoVerifyReport, type StoredSsoVerifyReport } from '@/lib/diagnose/ssoVerifyStore';

export const PROBE_ID = 'sso_verify';

export interface SsoVerifyProbeResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  /** Per-domain rows (user-facing + admin-reject), one item each. */
  items?: ProbeItem[];
}

/** True when the report represents a "couldn't run, nothing to verify"
 *  outcome rather than a real failure — the single config step is a `skip`
 *  and no domains were probed. Keeps a not-yet-configured box on `info`
 *  instead of nagging the operator with a red `fail`. */
function isSkipped(report: SsoVerifyReport): boolean {
  const onlyConfigSkip =
    report.steps.length > 0 &&
    report.steps.every(s => s.status === 'skip') &&
    report.userDomains.length === 0 &&
    report.adminDomains.length === 0;
  return onlyConfigSkip;
}

/** Map a single domain result to a diagnose item row. Admin rows pass
 *  when correctly blocked, so the item status mirrors the classifier's
 *  verdict directly (`pass` → ok, `fail` → fail). */
function domainItem(d: SsoDomainResult, kind: 'user' | 'admin'): ProbeItem {
  return {
    id: `${kind}:${d.domain}`,
    label: d.domain,
    detail: d.detail,
    status: d.status === 'pass' ? 'ok' : d.status === 'skip' ? 'info' : 'fail',
    actionIds: [],
  };
}

/** Build the steps-summary line that fronts the detail block — the
 *  domain breakdown lives in `items[]`, but a failed *step* (e.g. login
 *  never happened) needs to be visible even when there are zero domain
 *  rows. */
function stepsSummary(steps: SsoStepResult[]): string {
  const failed = steps.filter(s => s.status === 'fail');
  if (failed.length === 0) return '';
  return ` Failed step(s): ${failed.map(s => `${s.id} (${s.detail})`).join('; ')}.`;
}

/** The warn result for a "couldn't run the test" report (#1673) — the test
 *  harness (e.g. provisioning the ephemeral user) failed, so login was never
 *  exercised. A warn, not a red fail, so it doesn't scare an operator toward
 *  a reinstall on a healthy box. */
function couldNotRunResult(
  report: SsoVerifyReport,
  when: string,
  cleanupNote: string,
  items: ProbeItem[],
): SsoVerifyProbeResult {
  return {
    status: 'warn',
    detail:
      `SSO verification couldn't complete its own setup, so login was not actually tested.${stepsSummary(report.steps)} ` +
      `This is a problem with the test harness (e.g. provisioning the temporary user), not necessarily with SSO itself. (${when})${cleanupNote}`,
    hint: 'Real SSO may well be fine. Check that LLDAP admin credentials are stored (Settings → Integrations) and that the auth-lldap container is up, then re-run. Only the failed setup step(s) above need attention — the per-domain login checks never ran.',
    items: items.length > 0 ? items : undefined,
  };
}

/** Turn a stored report into the probe shape. Pure — unit-tested. */
export function reportToProbe(stored: StoredSsoVerifyReport | null): SsoVerifyProbeResult {
  if (!stored) {
    return {
      status: 'info',
      detail: 'SSO verification has not run yet. Click "Run SSO check" to verify login + per-domain access end to end.',
    };
  }
  const { report, at } = stored;
  const when = `last run ${at}`;

  if (isSkipped(report)) {
    return {
      status: 'info',
      detail: `${report.steps[report.steps.length - 1]?.detail ?? 'Nothing to verify.'} (${when})`,
    };
  }

  const userPass = report.userDomains.filter(d => d.status === 'pass').length;
  const adminPass = report.adminDomains.filter(d => d.status === 'pass').length;
  const items = [
    ...report.userDomains.map(d => domainItem(d, 'user')),
    ...report.adminDomains.map(d => domainItem(d, 'admin')),
  ];

  const cleanupNote = report.cleanedUp
    ? ''
    : ` Warning: the ephemeral user ${report.ephemeralUser} could not be deleted — remove it from LLDAP manually.`;

  if (report.ok) {
    return {
      status: 'ok',
      detail:
        `SSO works end to end: ${userPass}/${report.userDomains.length} user domains reachable, ` +
        `${adminPass}/${report.adminDomains.length} admin domains correctly blocked. (${when})${cleanupNote}`,
      items,
    };
  }

  // #1673: a setup-step failure ("couldn't run the test") must NOT read as a
  // red "SSO is broken" — that false-red nearly triggered an unnecessary
  // reinstall on a healthy box. Surface it as a warn that names the setup
  // step, so the operator knows the *test* couldn't run, not that login broke.
  if (report.couldNotRun) {
    return couldNotRunResult(report, when, cleanupNote, items);
  }

  return {
    status: 'fail',
    detail:
      `SSO verification found problems: ${userPass}/${report.userDomains.length} user domains reachable, ` +
      `${adminPass}/${report.adminDomains.length} admin domains correctly blocked.${stepsSummary(report.steps)} (${when})${cleanupNote}`,
    hint: 'Open the rows below for the per-domain detail. A failed user domain usually means Authelia forward-auth or the upstream service is down; a failed admin row means a family-only user reached an admin-only host (ACL bypass).',
    items: items.length > 0 ? items : undefined,
  };
}

/** Read the persisted report and render it as a probe. Never throws — a
 *  store read error degrades to "not run yet" (info). */
export async function checkSsoVerify(): Promise<SsoVerifyProbeResult> {
  try {
    const stored = await loadSsoVerifyReport();
    return reportToProbe(stored);
  } catch (e) {
    return {
      status: 'info',
      detail: `Could not read the SSO verification report: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Action: run the full verification on demand + persist the fresh report.
// ---------------------------------------------------------------------------

async function runNow({ node }: { node: string }): Promise<ProbeActionResult> {
  try {
    const report = await verifySso({ node });
    await saveSsoVerifyReport(report);
    const userPass = report.userDomains.filter(d => d.status === 'pass').length;
    const adminPass = report.adminDomains.filter(d => d.status === 'pass').length;
    if (isSkipped(report)) {
      return {
        ok: true,
        message: report.steps[report.steps.length - 1]?.detail ?? 'Nothing to verify (SSO not configured yet).',
        refresh: true,
      };
    }
    const message = report.ok
      ? `SSO check passed: ${userPass}/${report.userDomains.length} user domains, ${adminPass}/${report.adminDomains.length} admin domains correctly blocked.`
      : `SSO check found problems — ${userPass}/${report.userDomains.length} user domains reachable, ${adminPass}/${report.adminDomains.length} admin blocked. See the rows for detail.`;
    return { ok: report.ok, message, refresh: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`diagnose:${PROBE_ID}`, `run_now action threw: ${message}`);
    return { ok: false, message: `SSO check failed to run: ${message}`, refresh: false };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'run_now',
    label: 'Run SSO check',
    description:
      'Creates a temporary test user, logs it in through Authelia, checks every user-facing domain loads and every admin-only domain is blocked, then deletes the test user. Takes ~10-20 s. Safe to run any time.',
  },
  runNow,
);
