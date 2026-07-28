/**
 * Runtime regression tests for templates/claude-dev/docker-entrypoint.sh.
 *
 * The actual cases live in tests/templates/claude_dev_entrypoint_test.sh
 * (bash, since the subject is bash: the suite sources the entrypoint with
 * CLAUDE_DEV_ENTRYPOINT_LIB=1 and drives its helpers against a fake
 * /workspace full of hostile directory names, with su/start-claude/ldapsearch
 * stubbed on PATH — far cleaner than re-implementing shell word-splitting in
 * JS).
 *
 * This vitest wrapper executes that suite and surfaces its output as a vitest
 * assertion, so `npm test` gives the same green/red signal (same pattern as
 * post_deploy_runtime.test.ts wrapping the Python post-deploy suite).
 *
 * What it guards (#2418): /workspace is group-writable by every `devshare`
 * member, so a checkout's basename is attacker-controlled. It must reach
 * `start-claude` as one literal argv element and never be re-parsed as shell
 * by the `su` the entrypoint runs — including via util-linux su's PERMUTING
 * getopt, which is why the `--` before the user name is load-bearing.
 * Skipped if bash isn't available on the runner.
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SH_TEST = path.join(REPO_ROOT, 'tests', 'templates', 'claude_dev_entrypoint_test.sh');

function bashAvailable(): boolean {
  try {
    execSync('bash --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('claude-dev docker-entrypoint.sh', () => {
  const testFn = bashAvailable() ? it : it.skip;

  // 30 s like the Python wrapper: the suite runs in well under a second, but
  // it spawns a few dozen short-lived processes (stubs, mktemp, find), which
  // a cold GHA runner can drag past vitest's 5 s default.
  testFn('passes its shell-injection + secret-hygiene regression suite', () => {
    const result = spawnSync('bash', [SH_TEST], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(
        `claude-dev entrypoint regression suite failed (exit ${result.status}):\n\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}\n`,
      );
    }
    expect(result.stdout).toMatch(/checks passed/);
    expect(result.stdout).not.toMatch(/^FAIL/m);
  }, 30_000);
});
