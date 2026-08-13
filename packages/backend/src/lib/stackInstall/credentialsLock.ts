/**
 * Per-process serialization for the credentials manifest.
 *
 * `saveConfig` holds its own lock, but every writer of
 * `config.installManifest.credentials` is a **read-merge-write**: two
 * concurrent writers compute their merge off the same snapshot and one
 * silently loses. Extracted from `capabilities/credentials.ts` when the
 * Vaultwarden push (#2519) became a second writer — the install handler
 * appends entries while the push marks them secured and drops their
 * passwords, and interleaving those two resurrects a password ServiceBay
 * has already declared gone.
 */
let queue: Promise<unknown> = Promise.resolve();

export function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}
