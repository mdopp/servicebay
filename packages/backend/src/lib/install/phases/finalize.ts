/**
 * Finalize — the writes that only a finished run is allowed to make (#2742 —
 * split out of `runner.ts`).
 *
 * Runs AFTER the job's terminal verdict is patched, and every step is
 * best-effort: a failure here must not turn a successful install into a
 * failed one.
 */
import { getConfig, saveConfig } from '@/lib/config';
import type { DeployContext } from './context';
import { log } from './context';

export async function runFinalizePhase(ctx: DeployContext): Promise<void> {
  const { jobId, input } = ctx;

  // Persist every secret-typed variable so the next install can reuse
  // them (#615). Has to happen after `phase: 'done'` because we only
  // want to record values from a successful run — a half-failed install
  // might have rewritten LLDAP's DB with a new password mid-flight, and
  // the operator's recovery action could be to retry with the previous
  // value. Best-effort: a write failure here doesn't fail the install
  // (config might be temporarily locked); the next successful install
  // gets another chance.
  try {
    const { persistInstalledSecrets } = await import('../savedSecrets');
    await persistInstalledSecrets(input.variables, await getConfig());
  } catch (e) {
    await log(jobId, `(note) couldn't persist installed secrets: ${e instanceof Error ? e.message : String(e)}`);
  }

  // #2531 — and the same for the operator-set NON-secret variables, so the
  // next reinstall doesn't rebuild them from `variables.json` defaults and
  // blank a value the operator typed. Same post-`done` placement and
  // best-effort contract as the secrets above.
  try {
    const { persistInstalledVariables } = await import('../savedVariables');
    await persistInstalledVariables(input.variables, await getConfig());
  } catch (e) {
    await log(jobId, `(note) couldn't persist operator-set variables: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The CoreOS first-boot installer writes `stackSetupPending: true`
  // to flag "we set the box up, but no stack services are deployed
  // yet". The OnboardingWizard / Sidebar / /setup page all read that
  // flag. Historically it was only cleared by the operator clicking
  // "Finish" on /setup — so even after one or many successful
  // installs the flag stayed armed, the wizard's auto-open kept
  // suppressing (terminal-job + stackSetupPending branch), and a
  // re-install required clicking Finish on the *old* setup view
  // first. Now: a successful install proves the operator has stack
  // services. Clear the flag inline so the next re-install flow
  // doesn't get gated by stale onboarding state.
  try {
    const cfg = await getConfig();
    if (cfg.stackSetupPending) {
      delete cfg.stackSetupPending;
      await saveConfig(cfg);
    }
  } catch (e) {
    // Best-effort: a config write failure shouldn't fail the install
    // job itself — the operator can always click Finish manually.
    await log(jobId, `(note) couldn't clear stackSetupPending: ${e instanceof Error ? e.message : String(e)}`);
  }
}
