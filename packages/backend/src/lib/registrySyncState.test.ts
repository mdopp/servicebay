/**
 * #2610 — a registry that never syncs must not be reported as refreshed.
 *
 * These are the pure halves of the fix: how a git failure is classified into
 * something an operator can act on, how a credential-bearing URL is scrubbed
 * before it reaches a log/state file/UI, and how the install line is built so
 * the denominator is always in it.
 */
import { describe, it, expect } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  REGISTRY_GIVE_UP_AFTER,
  classifyRegistrySyncFailure,
  formatRegistrySyncLog,
  hasGivenUp,
  isDueForRetry,
  loadRegistrySyncState,
  redactRegistryUrl,
  redactSecrets,
  registryStateKey,
  retryDelayMs,
  type RegistrySyncRecord,
  type RegistrySyncSummary,
} from './registrySyncState';

// DATA_DIR is read by ./dirs at import time — set it in a hoisted block, with
// require() because the ESM imports above are not initialised yet in there.
const dataDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sb-registry-state-'));
  process.env.DATA_DIR = dir;
  return dir;
});

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

  it('reads GitHub throttling anonymous git traffic as transient, never as "private" (#2809)', () => {
    // The box-side message from 2026-09-02: the same throttle that killed the
    // autoloop seal in #2761, now hitting the registry clone from the container.
    const throttle = classifyRegistrySyncFailure(
      'Command failed: git clone --depth 1 …\nfatal: remote error: GitHub is temporarily limiting some unauthenticated downloads to protect the stability of the platform. Please retry later or authenticate.',
    );
    expect(throttle.kind).toBe('throttled');
    expect(throttle.reason).not.toMatch(/private/i);
    expect(throttle.advice).not.toMatch(/make the repository public/i);

    // A bare 403 is the same thing seen through curl's eyes — GitHub answers a
    // private repo with 401 (the username prompt), not 403.
    expect(classifyRegistrySyncFailure("fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 403").kind)
      .toBe('throttled');
    expect(classifyRegistrySyncFailure('fatal: The requested URL returned error: 429').kind).toBe('throttled');
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

describe('stalled is a cooldown, not a latch (#2809)', () => {
  const MIN = 60_000;
  const H = 60 * MIN;
  const at = (ms: number) => new Date(ms).toISOString();
  const stalled = (over: Partial<RegistrySyncRecord>): RegistrySyncRecord => ({
    name: 'solbay',
    url: 'https://github.com/mdopp/solarisbay',
    consecutiveFailures: REGISTRY_GIVE_UP_AFTER,
    kind: 'throttled',
    lastAttemptAt: at(0),
    ...over,
  });

  it('a record below the threshold is always due', () => {
    expect(isDueForRetry(undefined, at(0))).toBe(true);
    expect(isDueForRetry(stalled({ consecutiveFailures: 1 }), at(0))).toBe(true);
  });

  it('a transient cause backs off from 15 min and doubles per further failure, capped at 6 h', () => {
    expect(retryDelayMs(stalled({}))).toBe(15 * MIN);
    expect(retryDelayMs(stalled({ consecutiveFailures: REGISTRY_GIVE_UP_AFTER + 1 }))).toBe(30 * MIN);
    expect(retryDelayMs(stalled({ consecutiveFailures: REGISTRY_GIVE_UP_AFTER + 2 }))).toBe(60 * MIN);
    expect(retryDelayMs(stalled({ consecutiveFailures: REGISTRY_GIVE_UP_AFTER + 40 }))).toBe(6 * H);
    expect(retryDelayMs(stalled({ kind: 'network' }))).toBe(15 * MIN);
    expect(retryDelayMs(stalled({ kind: 'unknown' }))).toBe(15 * MIN);
  });

  it('a cause that needs a human is still re-checked daily, so a fixed repo is picked up without the button', () => {
    expect(retryDelayMs(stalled({ kind: 'credentials' }))).toBe(24 * H);
    expect(retryDelayMs(stalled({ kind: 'not-found', consecutiveFailures: 50 }))).toBe(24 * H);
  });

  it('is skipped inside the cooldown and due once it has passed — the 2026-09-02 box shape', () => {
    // Three failures inside one 90-second throttle window…
    const r = stalled({ firstFailedAt: at(0), lastAttemptAt: at(85_000) });
    expect(isDueForRetry(r, at(2 * MIN))).toBe(false);
    // …must not mean "never again": the boot sync two days later retries.
    expect(isDueForRetry(r, at(85_000 + 15 * MIN))).toBe(true);
    expect(isDueForRetry(r, at(2 * 24 * H))).toBe(true);
  });

  it('a stalled record without a usable timestamp is due, never stuck', () => {
    expect(isDueForRetry(stalled({ lastAttemptAt: undefined }), at(0))).toBe(true);
    expect(isDueForRetry(stalled({ lastAttemptAt: 'garbage' }), at(0))).toBe(true);
  });
});

describe('state file — keys', () => {
  const statePath = path.join(dataDir, 'registry-sync-state.json');
  beforeEach(() => fs.rmSync(statePath, { force: true }));
  afterEach(() => fs.rmSync(statePath, { force: true }));

  it('separates name and url with a space, not the NUL byte that made this file binary to git', () => {
    expect(registryStateKey('solbay', 'https://github.com/mdopp/solarisbay')).toBe('solbay https://github.com/mdopp/solarisbay');
    expect(registryStateKey('solbay', 'https://github.com/mdopp/solarisbay')).not.toContain('\u0000');
  });

  it('migrates records a box persisted under the NUL-separated key, keeping their failure memory', async () => {
    const record = { name: 'solbay', url: 'https://github.com/mdopp/solarisbay', consecutiveFailures: 3, kind: 'credentials' };
    fs.writeFileSync(statePath, JSON.stringify({ 'solbay\u0000https://github.com/mdopp/solarisbay': record }));

    const state = await loadRegistrySyncState();

    expect(state[registryStateKey('solbay', 'https://github.com/mdopp/solarisbay')]).toMatchObject({ consecutiveFailures: 3 });
    expect(Object.keys(state).some(k => k.includes('\u0000'))).toBe(false);
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

  it('says a skipped registry was not retried this time, how many attempts so far, and that it will retry on its own', () => {
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
    const text = lines.join('\n');
    expect(text).toContain('Not retried this time (4 failed attempts so far');
    expect(text).toMatch(/retries automatically after a cooldown/);
    // Never the #2610 wording — "from now on" was the latch this replaces.
    expect(text).not.toMatch(/not retried automatically after/i);
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
