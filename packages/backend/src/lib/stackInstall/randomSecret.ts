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
/**
 * The alphabet every generated secret is drawn from: ASCII letters and
 * digits, **no symbols and no whitespace** (#2577).
 *
 * This has been the de-facto alphabet since #19; it is now a stated
 * contract rather than an accident, because generated secrets are typed
 * and pasted into places that are far less forgiving than a browser: IoT
 * firmware credential fields, device apps, shell one-liners, config files
 * with their own quoting rules. A symbol that one of those mangles turns
 * into "wrong username or password" at the device, which points the
 * operator at themselves instead of at the generator.
 *
 * Strength is carried by LENGTH, not by symbol variety — see
 * `DEFAULT_SECRET_LENGTH` / `DEVICE_SAFE_SECRET_LENGTH` below. Pinned by
 * `randomSecret.test.ts`; do not add punctuation here.
 */
export const SECRET_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Default generated length. 32 × log2(62) ≈ **190 bits** — far past any
 * offline-brute-force concern, and the length secrets have had since #19,
 * so nothing an operator already memorised changes shape.
 */
export const DEFAULT_SECRET_LENGTH = 32;

/**
 * Length for a secret an operator has to carry INTO a device (#2577).
 *
 * Proven at a real device on 2026-08-16: a Nuki Smart Lock Pro was
 * rejected by mosquitto (`disconnected: not authorised`) with the
 * generated 32-character value — pasted, so complete — while Home
 * Assistant accepted the very same credentials; a 24-character
 * alphanumeric value connected on the first try. The alphabet was
 * already alphanumeric in both cases (see `SECRET_CHARS`), so the only
 * property that differed was the length: consumer firmware routinely caps
 * its credential field and silently keeps the prefix, and a truncated
 * password fails as "credentials wrong".
 *
 * 24 × log2(62) ≈ **142 bits**. That is fewer bits than the 190-bit
 * default and still absurdly beyond reach — the broker stores a hash and
 * a network-facing guess rate is a few per second, so the gap between
 * 2^142 and 2^190 is the difference between two impossibilities. The
 * strength that actually changed here is at the device: a value the
 * firmware truncates authenticates NOTHING, which is 0 bits.
 */
export const DEVICE_SAFE_SECRET_LENGTH = 24;

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

export function generateRandomSecret(length = DEFAULT_SECRET_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SECRET_CHARS[unbiasedCharIndex()];
  }
  return out;
}
