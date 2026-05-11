/**
 * Browser-side random-secret generator used by the install flow's
 * variable form to pre-fill `type: 'secret'` fields with a sensible
 * default. The operator can still overwrite it with a memorable
 * value before deploying; the regenerate button cycles the field
 * back to a fresh value.
 *
 * Same alphabet/length the install flow has used since #19 — kept
 * stable so secrets the operator already memorized don't suddenly
 * change shape between releases. Pulled out into its own module
 * so OnboardingWizard, InstallerModal, and the future
 * StackInstallFlow consumer (#341) share one implementation
 * instead of three near-copies.
 */
export function generateRandomSecret(length = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map(b => chars[b % chars.length])
    .join('');
}
