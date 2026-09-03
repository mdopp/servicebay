/**
 * Proactive git auth for the autoloop scripts (#2761).
 *
 * GitHub throttles *unauthenticated* git-over-HTTPS with a plain
 * `fatal: remote error: GitHub is temporarily limiting some unauthenticated
 * downloads…` at `info/refs` — not a 401. `credential.helper = !gh auth
 * git-credential` is only consulted after a 401 challenge, so under the
 * throttle the helper never fires and every `git fetch`/`git pull` goes out
 * anonymously and dies. That killed a seal *after* it had merged.
 *
 * Fix: send the token proactively on every autoloop git call, via the
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env triple — an
 * ephemeral config that lives only in the child process's environment (never
 * `.git/config`, never a file, never a log line). The git endpoint wants
 * `Basic x-access-token:<token>`; `Bearer <token>` is rejected.
 *
 * House pattern: tsx, `node:` only, no new dep.
 */

import { execFileSync } from 'node:child_process';

/** A plain environment map — deliberately looser than `NodeJS.ProcessEnv`
 *  (which the Next types make NODE_ENV-mandatory) so callers and tests can hand
 *  in a bare object. */
export type EnvLike = Record<string, string | undefined>;

/** The one config key we inject — GitHub-scoped, so a non-GitHub remote is untouched. */
const AUTH_HEADER_KEY = 'http.https://github.com/.extraHeader';

/**
 * Read the gh CLI token. Returns null when `gh` is missing, unauthenticated or
 * slow — the callers then run plain, exactly as they did before this file.
 */
export function readGhToken(): string | null {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The `Authorization:` header value git should send for github.com. */
export function basicAuthHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

/**
 * Pure: `base` plus the GIT_CONFIG_* triple carrying the token. Appends at the
 * next free index so an already-set GIT_CONFIG_COUNT (e.g. a parent autoloop
 * process that already added its own) is preserved rather than clobbered.
 * A null token returns a plain copy of `base`.
 */
export function withGitAuth(base: EnvLike, token: string | null): NodeJS.ProcessEnv {
  const env: EnvLike = { ...base };
  if (!token) return env as NodeJS.ProcessEnv;
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const idx = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  env.GIT_CONFIG_COUNT = String(idx + 1);
  env[`GIT_CONFIG_KEY_${idx}`] = AUTH_HEADER_KEY;
  env[`GIT_CONFIG_VALUE_${idx}`] = basicAuthHeader(token);
  return env as NodeJS.ProcessEnv;
}

let cachedToken: { value: string | null } | null = null;

/**
 * The env to pass as `env:` to every autoloop `git` child process. The token
 * read is cached for the life of the process (one `gh auth token` per run).
 */
export function gitEnv(base: EnvLike = process.env): NodeJS.ProcessEnv {
  cachedToken ??= { value: readGhToken() };
  return withGitAuth(base, cachedToken.value);
}

/** Test seam: forget the cached token (and any injected one). */
export function resetGitAuthCache(token?: string | null): void {
  cachedToken = token === undefined ? null : { value: token };
}

/**
 * Scrub anything token-shaped out of text that is about to be printed. The
 * env never appears in an `execFileSync` error (it embeds argv, not env), but
 * a git/gh message can echo a header back, so redact before we re-throw.
 */
export function redactGitSecrets(text: string): string {
  let out = text
    .replace(/Authorization:\s*(Basic|Bearer)\s+\S+/gi, 'Authorization: $1 ***')
    .replace(/(GIT_CONFIG_VALUE_\d+)=\S+/g, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***');
  const token = cachedToken?.value;
  if (token) {
    out = out.split(token).join('***');
    out = out.split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('***');
  }
  return out;
}
