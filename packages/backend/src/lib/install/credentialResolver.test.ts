import { describe, it, expect } from 'vitest';
import {
  waitForCredentials,
  provideCredentials,
  skipCredentials,
  clearPendingCredentials,
} from './credentialResolver';

/**
 * Pins the pause/resume promise bookkeeping that gates an unattended
 * install on operator-supplied NPM credentials. A regression here
 * either freezes an install forever on the credential prompt or leaks
 * a dangling resolver — both invisible until the box hangs.
 *
 * The module owns a process-wide Map keyed by jobId, so each test uses
 * a UNIQUE jobId to stay isolated (there is no reset export by design —
 * pending prompts don't survive a restart).
 */

let seq = 0;
const jobId = (tag: string) => `test-job-${tag}-${seq++}`;

describe('credentialResolver — waitForCredentials / provideCredentials', () => {
  it('resolves with the exact object passed to provideCredentials', async () => {
    const id = jobId('provide');
    const pending = waitForCredentials(id);
    const creds = { email: 'admin@example.com', password: 's3cr3t' };

    expect(provideCredentials(id, creds)).toBe(true);
    await expect(pending).resolves.toEqual(creds);
  });

  it('provideCredentials returns false when no job is waiting', () => {
    // A resolve-signature or bookkeeping bug that "provides" to a
    // non-waiting id must be a no-op, not a throw or a silent success.
    expect(provideCredentials(jobId('nowait'), { email: 'a@b.c', password: 'x' })).toBe(false);
  });

  it('a second provideCredentials for the same job is a no-op (returns false, does not throw)', async () => {
    const id = jobId('double-provide');
    const pending = waitForCredentials(id);
    const first = { email: 'first@example.com', password: 'p1' };

    expect(provideCredentials(id, first)).toBe(true);
    // The entry was deleted on first provide; the second must not resolve
    // again (a double-resolve would corrupt the resumed install path).
    expect(provideCredentials(id, { email: 'second@example.com', password: 'p2' })).toBe(false);
    await expect(pending).resolves.toEqual(first);
  });
});

describe('credentialResolver — skipCredentials', () => {
  it('resolves null on skip (signature: null, not a creds object)', async () => {
    const id = jobId('skip');
    const pending = waitForCredentials(id);

    expect(skipCredentials(id)).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it('skipCredentials returns false when no job is waiting', () => {
    expect(skipCredentials(jobId('skip-nowait'))).toBe(false);
  });

  it('provide-then-skip is a no-op on skip (entry already consumed)', async () => {
    const id = jobId('provide-then-skip');
    const pending = waitForCredentials(id);
    const creds = { email: 'admin@example.com', password: 'pw' };

    expect(provideCredentials(id, creds)).toBe(true);
    expect(skipCredentials(id)).toBe(false);
    await expect(pending).resolves.toEqual(creds);
  });
});

describe('credentialResolver — clearPendingCredentials (abortJob path)', () => {
  it('resolves the pending promise with null and removes the entry', async () => {
    const id = jobId('clear');
    const pending = waitForCredentials(id);

    clearPendingCredentials(id);
    // abortJob must unblock the waiting runner, not leave it hanging.
    await expect(pending).resolves.toBeNull();
  });

  it('after clear, a later provide/skip is a safe no-op (no leak, no double-resolve)', async () => {
    const id = jobId('clear-then-provide');
    const pending = waitForCredentials(id);

    clearPendingCredentials(id);
    await expect(pending).resolves.toBeNull();

    // The entry is gone — a stale provide/skip from a racing route must
    // not find a resolver to fire twice.
    expect(provideCredentials(id, { email: 'a@b.c', password: 'x' })).toBe(false);
    expect(skipCredentials(id)).toBe(false);
  });

  it('is idempotent — clearing a non-pending job does nothing and does not throw', () => {
    const id = jobId('clear-idempotent');
    expect(() => clearPendingCredentials(id)).not.toThrow();
    // And a second clear on an already-cleared job is also safe.
    waitForCredentials(id);
    clearPendingCredentials(id);
    expect(() => clearPendingCredentials(id)).not.toThrow();
  });

  it('no resolver leaks after resolve — provide fully consumes the entry', () => {
    // If provide left the entry behind, a subsequent clear would resolve
    // an already-settled promise (harmless) but signal a bookkeeping leak.
    const id = jobId('no-leak');
    waitForCredentials(id);
    expect(provideCredentials(id, { email: 'a@b.c', password: 'x' })).toBe(true);
    // Entry gone: provide/skip/clear all find nothing.
    expect(provideCredentials(id, { email: 'a@b.c', password: 'x' })).toBe(false);
    expect(skipCredentials(id)).toBe(false);
    expect(() => clearPendingCredentials(id)).not.toThrow();
  });
});
