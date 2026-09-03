// First-run wizard contracts — #2745.
//
// Replaced `packages/frontend/src/app/actions/onboarding.ts`. The wizard
// runs against a logged-in session (the app has no un-authenticated
// surface: `/api/*` is session-gated in `proxy.ts` and the operator signs
// in with the bootstrap password before the wizard renders), so these
// routes are gated exactly like every other admin route.

import { z } from 'zod';
import { callApi, mutateApi } from './client';

/**
 * `installInProgress` is set when an install job is running in *some*
 * session. Other tabs/devices use it to attach to the existing job
 * (`useStackInstall.attachToJob`) instead of starting a second one, and
 * `updatedAt` is how the wizard tells "still working" from "stalled"
 * (#727). A crashed server flips its jobs to `phase=crashed` on next
 * boot, so this never stays stuck on a dead install.
 */
export const OnboardingStatusSchema = z.object({
  needsSetup: z.boolean(),
  stackSetupPending: z.boolean(),
  hasGateway: z.boolean(),
  hasSshKey: z.boolean(),
  hasExternalLinks: z.boolean(),
  installInProgress: z
    .object({
      jobId: z.string(),
      startedAt: z.string(),
      updatedAt: z.string(),
      source: z.string().optional(),
    })
    .nullable(),
  features: z.object({
    gateway: z.boolean(),
    ssh: z.boolean(),
    updates: z.boolean(),
    registries: z.boolean(),
    email: z.boolean(),
    auth: z.boolean(),
  }),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

export const OnboardingEmailConfigSchema = z.object({
  host: z.string(),
  port: z.coerce.number(),
  secure: z.boolean(),
  user: z.string(),
  pass: z.string(),
  from: z.string(),
  /** Comma-separated in the wizard field; split server-side. */
  recipients: z.string(),
});
export type OnboardingEmailConfig = z.input<typeof OnboardingEmailConfigSchema>;

/**
 * One route, one discriminant per wizard step. Each variant persists the
 * slice of `config.json` that step owns; nothing else is touched.
 */
export const OnboardingConfigRequestSchema = z.discriminatedUnion('section', [
  z.object({
    section: z.literal('gateway'),
    host: z.string(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  z.object({ section: z.literal('publicDomain'), publicDomain: z.string() }),
  z.object({ section: z.literal('autoUpdate'), enabled: z.boolean() }),
  z.object({ section: z.literal('registries'), enabled: z.boolean() }),
  z.object({ section: z.literal('email'), email: OnboardingEmailConfigSchema }),
]);

/** `setup` finishes onboarding itself; `stack` clears the stack-setup follow-up. */
export const OnboardingCompleteRequestSchema = z.object({
  target: z.enum(['setup', 'stack']),
});

export const OnboardingAckSchema = z.object({ success: z.literal(true) });

/** GET /api/system/onboarding */
export function checkOnboardingStatus() {
  return callApi('/api/system/onboarding', OnboardingStatusSchema);
}

function saveOnboardingConfig(body: z.input<typeof OnboardingConfigRequestSchema>) {
  return mutateApi('/api/system/onboarding/config', OnboardingAckSchema, body);
}

export function saveGatewayConfig(host: string, username?: string, password?: string) {
  return saveOnboardingConfig({ section: 'gateway', host, username, password });
}

/**
 * Persist the public domain captured in the wizard's network step (#662).
 * An empty string means "LAN-only install" — an explicit operator choice
 * that reverts `publicDomain` to not-configured.
 */
export function savePublicDomainConfig(publicDomain: string) {
  return saveOnboardingConfig({ section: 'publicDomain', publicDomain });
}

export function saveAutoUpdateConfig(enabled: boolean) {
  return saveOnboardingConfig({ section: 'autoUpdate', enabled });
}

export function saveRegistriesConfig(enabled: boolean) {
  return saveOnboardingConfig({ section: 'registries', enabled });
}

export function saveEmailConfig(email: OnboardingEmailConfig) {
  return saveOnboardingConfig({ section: 'email', email });
}

/** POST /api/system/onboarding/complete — mark onboarding itself done. */
export function skipOnboarding() {
  return mutateApi('/api/system/onboarding/complete', OnboardingAckSchema, { target: 'setup' });
}

/** POST /api/system/onboarding/complete — clear the stack-setup follow-up. */
export function completeStackSetup() {
  return mutateApi('/api/system/onboarding/complete', OnboardingAckSchema, { target: 'stack' });
}

/**
 * DELETE /api/system/onboarding/install-lock — force-clear a stuck install
 * so the operator can recover without restarting the server. Aborts the
 * runner if it is still alive; the job transitions to `phase=aborted` via
 * the runner's normal cleanup path.
 */
export function forceClearInstallLock() {
  return mutateApi('/api/system/onboarding/install-lock', OnboardingAckSchema, undefined, 'DELETE');
}
