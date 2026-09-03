/**
 * Self-test — the end-to-end SSO verification a finished install fires at
 * itself (#2742 — split out of `runner.ts`).
 */
import { log } from './context';

/**
 * Run the end-to-end SSO verification after a successful install and persist
 * the report (#1454, consumes #1453). Confirms a real family-group login can
 * reach every user-facing domain and is blocked from admin-only ones, then
 * saves the result so the diagnose `sso_verify` probe (#1455) surfaces it.
 *
 * Detached + fully best-effort: `verifySso` creates and *always* deletes an
 * ephemeral user, takes ~10-20 s, and must never block or fail the install.
 * A non-auth install is a calm skip inside `verifySso`. Any error here is
 * logged to the job and swallowed.
 */
export async function runSelfTestPhase(jobId: string, node: string | undefined): Promise<void> {
  try {
    const { verifySso } = await import('@/lib/diagnose/ssoVerify');
    const { saveSsoVerifyReport } = await import('@/lib/diagnose/ssoVerifyStore');
    const report = await verifySso({ node });
    await saveSsoVerifyReport(report);
    await log(
      jobId,
      report.ok
        ? 'SSO verification passed (per-domain report saved — see the SSO end-to-end check on the Health dashboard).'
        : `SSO verification finished with findings (report saved — see the SSO end-to-end check on the Health dashboard). Ephemeral user cleaned up: ${report.cleanedUp}.`,
    );
  } catch (e) {
    await log(jobId, `(note) post-install SSO verification did not complete: ${e instanceof Error ? e.message : String(e)}`);
  }
}
