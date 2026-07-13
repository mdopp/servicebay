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
const SECRET_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * One uniform index into `SECRET_CHARS` via rejection sampling: draw a random
 * byte and discard any that falls in the biased tail above the largest multiple
 * of the charset size. `byte % len` would skew the distribution whenever 256
 * isn't a multiple of `len` (js/biased-cryptographic-random) — the 62-char
 * alphabet here is exactly such a case. This yields a provably-unbiased pick.
 * Exported for tests.
 */
export function unbiasedCharIndex(len: number = SECRET_CHARS.length): number {
  const limit = Math.floor(256 / len) * len; // largest multiple of len ≤ 256
  const buf = new Uint8Array(1);
  let byte: number;
  do {
    crypto.getRandomValues(buf);
    byte = buf[0];
  } while (byte >= limit);
  return byte % len;
}

export function generateRandomSecret(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SECRET_CHARS[unbiasedCharIndex()];
  }
  return out;
}
