import { describe, it, expect, afterEach } from 'vitest';
import {
  withGitAuth,
  basicAuthHeader,
  gitEnv,
  resetGitAuthCache,
  redactGitSecrets,
  resolveFullSha,
} from './autoloop-git';

const TOKEN = 'gh-test-token-not-a-real-secret';
const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 40-char git sha
const SHORT = 'a1b2c3d4'; // the short sha the autoloop playbooks hand around

afterEach(() => resetGitAuthCache());

describe('withGitAuth', () => {
  it('adds the GIT_CONFIG triple git needs to send the token proactively (#2761)', () => {
    const env = withGitAuth({ PATH: '/usr/bin' }, TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    // Basic with the x-access-token user — the git endpoint rejects `Bearer`.
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('appends at the next free index instead of clobbering an inherited config', () => {
    const env = withGitAuth({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' }, TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_KEY_2).toBe('http.https://github.com/.extraHeader');
  });

  it('falls back to a plain env when no token is available (gh missing / logged out)', () => {
    const env = withGitAuth({ PATH: '/usr/bin' }, null);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('never mutates the base env it was handed', () => {
    const base = { PATH: '/usr/bin' };
    withGitAuth(base, TOKEN);
    expect(base).toEqual({ PATH: '/usr/bin' });
  });
});

describe('gitEnv', () => {
  it('uses the cached token and leaves the rest of the environment intact', () => {
    resetGitAuthCache(TOKEN);
    const env = gitEnv({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(env.HOME).toBe('/home/x');
    expect(env.GIT_CONFIG_VALUE_0).toBe(basicAuthHeader(TOKEN));
  });

  it('is a no-op env when the token read failed', () => {
    resetGitAuthCache(null);
    expect(gitEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
});

describe('redactGitSecrets', () => {
  it('scrubs the token, its base64 header and any token-shaped literal', () => {
    resetGitAuthCache(TOKEN);
    const header = basicAuthHeader(TOKEN);
    const text = `git failed: ${header}\nGIT_CONFIG_VALUE_0=${header}\nraw ${TOKEN} and ghp_${'A'.repeat(36)}`;
    const out = redactGitSecrets(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    expect(out).toContain('Authorization: Basic ***');
  });

  it('leaves ordinary git output alone', () => {
    resetGitAuthCache(null);
    expect(redactGitSecrets('fatal: remote error: GitHub is temporarily limiting some unauthenticated downloads')).toBe(
      'fatal: remote error: GitHub is temporarily limiting some unauthenticated downloads',
    );
  });
});

describe('resolveFullSha (#2837) — gh run list --commit needs the exact 40-char sha', () => {
  it('expands a short sha through git rev-parse', () => {
    const seen: string[] = [];
    const revParse = (rev: string) => {
      seen.push(rev);
      return `${FULL}\n`;
    };
    expect(resolveFullSha(SHORT, revParse)).toBe(FULL);
    expect(seen).toEqual([`${SHORT}`]);
  });

  it('passes a full sha straight through, without spending a git call', () => {
    const revParse = () => {
      throw new Error('rev-parse must not run for an already-full sha');
    };
    expect(resolveFullSha(FULL.toUpperCase(), revParse)).toBe(FULL);
  });

  it('returns null when the lookup FAILS — an unknown rev is not a resolution', () => {
    const revParse = () => {
      throw new Error("fatal: Needed a single revision");
    };
    expect(resolveFullSha(SHORT, revParse)).toBeNull();
  });

  it('returns null on a non-sha argument and on a non-sha answer', () => {
    expect(resolveFullSha('HEAD', () => FULL)).toBeNull();
    expect(resolveFullSha('', () => FULL)).toBeNull();
    expect(resolveFullSha(SHORT, () => 'ghcr.io/mdopp/servicebay:dev')).toBeNull();
  });
});
