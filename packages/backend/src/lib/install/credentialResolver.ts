/**
 * Pause-the-deploy-loop credential prompts for the install runner.
 *
 * The deploy loop runs unattended on the server, but the NPM
 * bootstrap step occasionally needs operator input — the operator's
 * preferred NPM admin email + password — when the wizard couldn't
 * silently pick them up. The runner publishes a `needs_credentials`
 * phase, then awaits the operator either submitting values or
 * skipping the prompt.
 *
 * Extracted from `runner.ts` in #975. The module owns:
 *   - the in-process map of pending prompts (one resolve callback per
 *     active install job),
 *   - the public `provideCredentials` / `skipCredentials` route entries
 *     the wizard calls,
 *   - `waitForCredentials`, awaited by the runner inside the deploy
 *     pipeline,
 *   - `clearPendingCredentials`, called from the runner's `abortJob`.
 *
 * Pending prompts do not survive a server restart — any job in this
 * phase at boot is flipped to `crashed` by jobStore.markCrashedOnStartup.
 */

const pendingCredentials = new Map<string, {
  resolve: (creds: { email: string; password: string } | null) => void;
}>();

/**
 * Resume a credentials-paused job with operator-supplied values.
 * Returns false if no job by that id was waiting for credentials.
 */
export function provideCredentials(
  jobId: string,
  creds: { email: string; password: string },
): boolean {
  const pending = pendingCredentials.get(jobId);
  if (!pending) return false;
  pendingCredentials.delete(jobId);
  pending.resolve(creds);
  return true;
}

/** Resume a credentials-paused job by skipping NPM. */
export function skipCredentials(jobId: string): boolean {
  const pending = pendingCredentials.get(jobId);
  if (!pending) return false;
  pendingCredentials.delete(jobId);
  pending.resolve(null);
  return true;
}

/**
 * Drop any pending credentials prompt for `jobId`. Called from the
 * runner's `abortJob` so a torn-down install doesn't leave the
 * resolve callback hanging in memory. Idempotent — no-op when nothing
 * was pending.
 */
export function clearPendingCredentials(jobId: string): void {
  const pending = pendingCredentials.get(jobId);
  if (pending) {
    pendingCredentials.delete(jobId);
    pending.resolve(null);
  }
}

/**
 * Pause the deploy loop until the operator submits NPM credentials
 * or skips the prompt. Also unblocks on `abortJob` via
 * `clearPendingCredentials`.
 *
 * The caller (the runner) is responsible for publishing the
 * `phase: 'needs_credentials'` state on the job — this function only
 * owns the pause + resume side of the contract.
 */
export function waitForCredentials(
  jobId: string,
): Promise<{ email: string; password: string } | null> {
  return new Promise(resolve => {
    pendingCredentials.set(jobId, { resolve });
  });
}
