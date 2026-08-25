/**
 * #2610 — a registry that never syncs must not be reported as refreshed.
 *
 * These are the pure halves of the fix: how a git failure is classified into
 * something an operator can act on, how a credential-bearing URL is scrubbed
 * before it reaches a log/state file/UI, and how the install line is built so
 * the denominator is always in it.
 */
import { describe, it, expect } from 'vitest';
import {
  REGISTRY_GIVE_UP_AFTER,
  classifyRegistrySyncFailure,
  formatRegistrySyncLog,
  hasGivenUp,
  redactRegistryUrl,
  redactSecrets,
  registryStateKey,
  type RegistrySyncSummary,
} from './registrySyncState';

describe('secret hygiene — a registry URL may carry credentials', () => {
  it('strips userinfo from a git URL', () => {
    const out = redactRegistryUrl('https://mdopp:ghp_examplevalue@github.com/mdopp/servicebay-templates');
    expect(out).not.toContain('ghp_examplevalue');
    expect(out).not.toContain('mdopp:');
    expect(out).toContain('github.com/mdopp/servicebay-templates');
  });

  it('leaves a credential-free URL untouched', () => {
    expect(redactRegistryUrl('https://github.com/mdopp/solarisbay')).toBe('https://github.com/mdopp/solarisbay');
  });

  it('still strips userinfo from a URL the URL parser rejects', () => {
    const out = redactRegistryUrl('git+weird://user:pw@host/x.git');
    expect(out).not.toContain('pw@');
  });

  it('scrubs the URL git echoes back inside its own error message', () => {
    const msg = redactSecrets(
      "fatal: could not read Username for 'https://mdopp:ghp_examplevalue@github.com': terminal prompts disabled",
    );
    expect(msg).not.toContain('ghp_examplevalue');
    expect(msg).toContain('terminal prompts disabled');
  });

  it('keys the state record by name AND url, so correcting the url starts fresh', () => {
    const a = registryStateKey('ServiceBay Templates', 'https://github.com/mdopp/servicebay-templates');
    const b = registryStateKey('ServiceBay Templates', 'https://github.com/mdopp/servicebay-templates.git');
    expect(a).not.toBe(b);
    // …and the key itself never carries a credential either.
    expect(registryStateKey('r', 'https://u:tok_example@h/x')).not.toContain('tok_example');
  });
});

describe('classifyRegistrySyncFailure — name the cause, and what to do', () => {
  it('reads the credential-less private repo as exactly that, not as a crash', () => {
    // The reference-box message, produced by GIT_TERMINAL_PROMPT=0.
    const d = classifyRegistrySyncFailure(
      "Command failed: git clone --depth 1 …\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    expect(d.kind).toBe('credentials');
    expect(d.reason).toMatch(/private/i);
    expect(d.advice).toMatch(/public|remove the registry/i);
    // The advice must never suggest that credentials can be stored today.
    expect(d.advice).toMatch(/cannot store registry credentials/i);
  });

  it('distinguishes a repo that is simply gone', () => {
    expect(classifyRegistrySyncFailure('remote: Repository not found.').kind).toBe('not-found');
  });

  it('distinguishes a network problem, which a later retry can clear', () => {
    expect(classifyRegistrySyncFailure('fatal: unable to access: Could not resolve host: github.com').kind)
      .toBe('network');
  });

  it('falls back to "git refused the clone" rather than inventing a cause', () => {
    const d = classifyRegistrySyncFailure('fatal: something nobody has seen before');
    expect(d.kind).toBe('unknown');
    expect(d.reason.length).toBeGreaterThan(0);
    expect(d.advice.length).toBeGreaterThan(0);
  });
});

describe('hasGivenUp', () => {
  it('needs REGISTRY_GIVE_UP_AFTER consecutive failures — one blip does not latch', () => {
    expect(hasGivenUp(undefined)).toBe(false);
    expect(hasGivenUp({ name: 'r', url: 'u', consecutiveFailures: 1 })).toBe(false);
    expect(hasGivenUp({ name: 'r', url: 'u', consecutiveFailures: REGISTRY_GIVE_UP_AFTER - 1 })).toBe(false);
    expect(hasGivenUp({ name: 'r', url: 'u', consecutiveFailures: REGISTRY_GIVE_UP_AFTER })).toBe(true);
  });
});

const summary = (partial: Partial<RegistrySyncSummary>): RegistrySyncSummary => ({
  requested: 0,
  synced: 0,
  failed: 0,
  skipped: 0,
  results: [],
  ...partial,
});

describe('formatRegistrySyncLog — the install dialog states what refreshed', () => {
  it('reports a clean run with both numbers, not a blanket claim', () => {
    const lines = formatRegistrySyncLog(
      summary({
        requested: 2,
        synced: 2,
        results: [
          { name: 'servicebay', url: 'https://github.com/mdopp/servicebay.git', status: 'synced' },
          { name: 'solbay', url: 'https://github.com/mdopp/solarisbay', status: 'synced' },
        ],
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refreshed 2 of 2 external registries');
    expect(lines[0]).toContain('servicebay, solbay');
  });

  it('never claims the whole when only a subset refreshed — the #2610 shape', () => {
    // The reference box exactly: one public registry syncs, one private one
    // never has and never will.
    const lines = formatRegistrySyncLog(
      summary({
        requested: 2,
        synced: 1,
        failed: 1,
        results: [
          { name: 'solbay', url: 'https://github.com/mdopp/solarisbay', status: 'synced' },
          {
            name: 'ServiceBay Templates',
            url: 'https://github.com/mdopp/servicebay-templates',
            status: 'failed',
            kind: 'credentials',
            reason: 'the repository is private and this box has no credentials for it',
            advice: 'Make the repository public, or remove the registry in Settings.',
            consecutiveFailures: 1,
          },
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Refreshed 1 of 2 external registries');
    expect(text).toContain('Not refreshed: ServiceBay Templates');
    expect(text).toContain('private and this box has no credentials');
    // The consequence for the operator who just committed a template there.
    expect(text).toMatch(/installed from the copy already on disk/);
    // Every line about a failure is marked, so it survives a collapsed tail.
    expect(lines.every(l => l.startsWith('⚠️'))).toBe(true);
  });

  it('says a skipped registry was not retried, and after how many attempts', () => {
    const lines = formatRegistrySyncLog(
      summary({
        requested: 2,
        synced: 1,
        skipped: 1,
        results: [
          { name: 'servicebay', url: 'https://github.com/mdopp/servicebay.git', status: 'synced' },
          {
            name: 'ServiceBay Templates',
            url: 'https://github.com/mdopp/servicebay-templates',
            status: 'skipped',
            kind: 'credentials',
            reason: 'the repository is private and this box has no credentials for it',
            advice: 'Make the repository public, or remove the registry in Settings.',
            consecutiveFailures: 4,
          },
        ],
      }),
    );
    expect(lines.join('\n')).toContain('Not retried automatically after 4 failed attempts');
  });

  it('reports a run where nothing refreshed as 0 of N, not as silence', () => {
    const lines = formatRegistrySyncLog(
      summary({
        requested: 1,
        failed: 1,
        results: [{ name: 'servicebay', url: 'u', status: 'failed', reason: 'git refused the clone' }],
      }),
    );
    expect(lines[0]).toContain('Refreshed 0 of 1 external registry');
  });
});
