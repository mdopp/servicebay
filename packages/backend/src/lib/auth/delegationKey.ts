import crypto from 'node:crypto';

/**
 * Delegated-admin trust key (#2270, ADR 0011 building on ADR 0009).
 *
 * The HMAC key ServiceBay uses to verify the SHORT-LIVED, ACTION-BOUND
 * user+scope assertions that a trusted server-server caller (Solaris) presents
 * when it wants to act AS an authenticated admin user for a mutating admin
 * action (approve/deny, service-operate).
 *
 * WHY DERIVE FROM AUTH_SECRET — the reinstall-survival requirement:
 *   ADR 0009 §1 makes `AUTH_SECRET`/`secret.key` the box's per-box IDENTITY:
 *   they MUST survive a wipe-config reinstall (they are NOT regenerated when a
 *   preserved `enc:`-bearing config is present). By DERIVING this key from
 *   AUTH_SECRET — exactly the same HMAC-with-a-domain-label pattern as
 *   `internalToken.ts` (SB_API_TOKEN) — the delegation trust key inherits that
 *   survival property for free: no new persisted file, no new boot-init unit,
 *   no key that "regenerates on reinstall" (the ADR-0009 footgun this ADR is
 *   explicitly told to avoid). Both peers derive the same value from the shared
 *   root-of-trust; the operator provisions Solaris with the box's AUTH_SECRET
 *   (or a key derived from it) out of band, the same trust class as the
 *   service token it already holds.
 *
 * Domain separation: a DISTINCT label from `internalToken.ts` so this key is
 * cryptographically independent of SB_API_TOKEN — a compromise of one HMAC
 * output never reveals the AUTH_SECRET nor the other derived key.
 *
 * Read AUTH_SECRET lazily (module may be imported before it is set in tests).
 */

const DELEGATION_KEY_LABEL = 'servicebay:delegated-admin:v1';

let cached: Buffer | null = null;

/**
 * The 32-byte HMAC key for signing/verifying delegated-admin assertions.
 * Deterministic for a given AUTH_SECRET → survives restarts and reinstalls
 * that preserve AUTH_SECRET (ADR 0009 §1). Never leaves the process; only its
 * HMAC output over an assertion is ever compared.
 */
export function getDelegationKey(): Buffer {
  if (cached) return cached;
  const secret = process.env.AUTH_SECRET ?? '';
  if (!secret) {
    // Without AUTH_SECRET the install is unsupportable (ADR 0009). Fail toward a
    // per-process random key so verification of ANY externally-minted assertion
    // fails closed (deny) rather than crashing at import; the rest of the app
    // surfaces the missing-AUTH_SECRET configuration error on its own.
    cached = crypto.randomBytes(32);
    return cached;
  }
  cached = crypto.createHmac('sha256', secret).update(DELEGATION_KEY_LABEL).digest();
  return cached;
}

/** Test-only: drop the cached key so a test can flip AUTH_SECRET and re-derive
 *  (e.g. to assert the derivation is deterministic across a simulated reinstall
 *  that preserves AUTH_SECRET, and changes when AUTH_SECRET changes). */
export function resetDelegationKeyCache(): void {
  cached = null;
}
