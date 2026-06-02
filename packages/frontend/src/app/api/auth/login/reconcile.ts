// Credential reconciliation for the ServiceBay admin login.
//
// `config.auth.passwordHash` lives on /mnt/data, which SURVIVES a reinstall.
// A reinstall bakes a fresh `SERVICEBAY_PASSWORD` into the quadlet and hands
// the operator that new password — but a stored hash from a prior install
// would shadow it, locking the operator out (issue #1438). This is the same
// reinstall-over-persisted-data credential-lockout class we already auto-heal
// for LLDAP (FORCE_RESET) and NPM (auto-rekey).
//
// Policy (self-heal-when-safe, never mask a failure):
//   1. The STORED hash is always tried first. A deliberately operator-changed
//      password keeps working and is never overridden — the env password only
//      ever wins when the stored credential does NOT authenticate the request.
//   2. If the stored hash rejects the password but the env bootstrap password
//      accepts it, the request is at the genuine reinstall/bootstrap boundary:
//      authenticate AND re-key the stored hash to the env password so the
//      stored credential converges on what sb showed the operator.
//   3. With no stored hash, the env password authenticates as before.
//
// The verify/hash primitives are injected so this module stays pure and
// Next.js-free (testable without the route handler).

export interface ReconcileInput {
  /** The password supplied by the client. */
  candidate: string;
  /** Stored hash from config.auth.passwordHash (undefined / invalid => treated as absent). */
  storedHash: string | null;
  /** The deploy-time SERVICEBAY_PASSWORD env value, if set. */
  bootstrapPassword: string | null;
}

export interface ReconcileDeps {
  verifyPassword: (plain: string, encoded: string) => Promise<boolean>;
  hashPassword: (plain: string) => Promise<string>;
}

export interface ReconcileResult {
  /** Whether the candidate authenticated. */
  authenticated: boolean;
  /**
   * When set, the stored hash should be (re)written to this value: either the
   * freshly-minted bootstrap hash on a reinstall reconcile, or the first-login
   * seed when there was no stored hash yet. Undefined => leave config untouched.
   */
  newStoredHash?: string;
}

/**
 * Decide whether the candidate password authenticates and whether the stored
 * hash should be reconciled. Runs verifies in a fixed order so a stored hash
 * is never silently overridden by the env password unless the stored hash
 * actually rejects the request.
 *
 * The caller is responsible for the username match and the timing-equalization
 * dummy verify on a username miss; this helper assumes the username matched.
 */
export async function reconcileLogin(
  input: ReconcileInput,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const { candidate, storedHash, bootstrapPassword } = input;

  // 1. Stored credential takes precedence — an operator-changed password keeps
  //    working and is never overridden by the env password.
  if (storedHash) {
    if (await deps.verifyPassword(candidate, storedHash)) {
      return { authenticated: true };
    }
    // Stored hash rejected. Reinstall/bootstrap boundary: the env password may
    // be the new credential the operator was handed. Allow it to win HERE only,
    // and re-key the stored hash so the stored credential converges on it.
    if (bootstrapPassword) {
      const bootstrapHash = await deps.hashPassword(bootstrapPassword);
      if (await deps.verifyPassword(candidate, bootstrapHash)) {
        return { authenticated: true, newStoredHash: bootstrapHash };
      }
    }
    return { authenticated: false };
  }

  // 2. No stored hash: env password authenticates and seeds the stored hash.
  if (bootstrapPassword) {
    const bootstrapHash = await deps.hashPassword(bootstrapPassword);
    if (await deps.verifyPassword(candidate, bootstrapHash)) {
      return { authenticated: true, newStoredHash: bootstrapHash };
    }
  }

  return { authenticated: false };
}
