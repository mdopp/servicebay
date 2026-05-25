/**
 * Runtime smoke tests for templates/<name>/post-deploy.py scripts.
 *
 * The actual test cases live in tests/templates/test_post_deploy.py
 * (Python unittest, since the scripts are Python and are loaded via
 * importlib + monkey-patched urllib for HTTP mocking — far cleaner
 * than spawning each script as a subprocess from JS).
 *
 * This vitest wrapper executes the Python suite via `python3 -m
 * unittest`, parses the output, and surfaces individual failures as
 * vitest assertions so a developer running `npm test` sees the same
 * green/red signal regardless of which world the failure came from.
 *
 * Skipped if python3 isn't available on the runner.
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PY_TEST = path.join(REPO_ROOT, 'tests', 'templates', 'test_post_deploy.py');

function pythonAvailable(): boolean {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('post-deploy.py runtime smoke tests', () => {
  const testFn = pythonAvailable() ? it : it.skip;
  // 30 s timeout (vs vitest's 5 s default). The Python suite itself runs
  // in <1 s on a warm machine, but cold-cache python3 + unittest spawn
  // on a GHA runner has been observed to exceed 5 s, triggering false
  // "Test timed out" failures on push:main runs (introduced by #972).
  // Bumping to 30 s gives ~30x headroom over normal runtime while still
  // catching a genuinely-hung Python process.
  testFn('every script passes its unittest cases', () => {
    const result = spawnSync(
      'python3',
      ['-m', 'unittest', '-v', PY_TEST],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `Python post-deploy smoke tests failed (exit ${result.status}):\n\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}\n`,
      );
    }
    // unittest prints to stderr by default; the trailing OK confirms success.
    expect(result.stderr).toMatch(/\nOK\b/);
  }, 30_000);
});
