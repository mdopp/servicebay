/**
 * Autoloop SEAL mechanics as a deterministic script (#2306).
 *
 * The seal step — push the batch, watch CI, merge on green, decide whether the
 * merge is path-mandated (→ box-verify owed) — is 100% deterministic, yet it
 * lived as free-text in stages/builder.md that a fresh sub-agent re-ran each
 * time. That's what wedged the seal builders this session: an LLM interpreting
 * "watch CI" armed a Monitor and yielded, dying mid-seal after committing but
 * before pushing (memory feedback_seal_builder_ci_watch_wedge). As a script the
 * invariants are STRUCTURAL, not advisory:
 *   - push always uses `--no-verify` (the husky pre-push hook re-runs the full
 *     vitest+build — slow, flaky, and silently fails a plain push; CI is the
 *     authoritative gate);
 *   - CI is watched by a HARD-CAPPED poll loop that RETURNS (never an unbounded
 *     wait / Monitor);
 *   - merge happens ONLY on all-green.
 * The orchestrator (deterministic dispatch) calls this instead of spawning a
 * wedge-prone seal sub-agent. LLMs stay for JUDGMENT: diagnosing a red,
 * fixing forward. (CLAUDE.md: "Deterministic execution → scripts; LLMs
 * coordinate + evaluate.")
 *
 * House pattern: tsx, node: only, no new runtime dep (sibling to
 * scripts/check-diff-coverage.ts).
 *
 *   tsx scripts/autoloop-seal.ts <batchBranch> [--title "<PR title>"] [--body-file <path>]
 *
 * Emits a single machine-readable last line for the orchestrator to fold into
 * work-queue.json (this script never writes the queue — single-writer is the
 * orchestrator):
 *   AUTOLOOP_SEAL_RESULT {"ok":true,"pr":123,"sha":"abc1234","pathMandated":[...],"boxVerifyOwed":true,"detail":"..."}
 *
 * Exit codes: 0 merged; 3 CI red (result carries the failing checks — LLM
 * decides fix-forward); 2 setup error (dirty tree, bad branch, merge conflict).
 */

import { execFileSync } from 'node:child_process';

/**
 * Path prefixes/files whose change means the release must run a real on-box
 * `:dev` verify before shipping to `:latest`. This is the CANONICAL list
 * (stages/builder.md should reference it). Broader than the old builder.md
 * copy: this session proved the NPM-render + proxy-gate + auth files
 * (forwardAuth/provisioner/proxy) also warrant box-verify. Matching is
 * prefix-based (a trailing `/` marks a directory; otherwise an exact file).
 */
export const PATH_MANDATED_PATHS: readonly string[] = [
  // install / deploy path
  'packages/backend/src/lib/install/',
  'packages/backend/src/lib/config.ts',
  'packages/backend/src/lib/agent/',
  'packages/backend/src/lib/systemBackup.ts',
  'packages/backend/src/lib/mcp/',
  // NPM reverse-proxy / forward-auth render (forwardAuth.ts, provisioner.ts)
  'packages/backend/src/lib/stackInstall/',
  'packages/backend/src/lib/portal/',
  // request-path gate + middleware (proxy.ts CSRF/internal-token gate)
  'packages/frontend/src/proxy.ts',
  'packages/frontend/src/middleware.ts',
  // user-facing surfaces that gate=verify covers
  'packages/frontend/src/app/portal/',
  'packages/frontend/src/app/(dashboard)/',
  'packages/frontend/src/dashboards/',
  'packages/frontend/src/components/OnboardingWizard.tsx',
];

/** Pure: does a repo-relative path trigger box_verify=owed? Prefix match for
 *  directory entries (trailing `/`), exact match for file entries. Exported so
 *  the matching is unit-tested without git. */
export function isPathMandated(file: string): boolean {
  return PATH_MANDATED_PATHS.some(p => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

// ---- everything below runs only when invoked as a script ----

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function shSafe(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: sh(cmd, args) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
}
function emit(result: Record<string, unknown>): void {
  console.log(`AUTOLOOP_SEAL_RESULT ${JSON.stringify(result)}`);
}
function fail(code: number, result: Record<string, unknown>): never {
  emit({ ok: false, ...result });
  process.exit(code);
}

/** Poll CI for the PR in a HARD-CAPPED loop that always returns.
 *  → 'green' (all non-pending, none failed), 'red' (a check failed), or
 *  'timeout'. Never an unbounded wait — this is the anti-wedge core. */
function watchCi(pr: number, maxPolls = 20, intervalSec = 30): { verdict: 'green' | 'red' | 'timeout'; failing: string[] } {
  for (let i = 0; i < maxPolls; i++) {
    sh('sleep', [String(intervalSec)]);
    const res = shSafe('gh', ['pr', 'checks', String(pr), '--json', 'name,state,bucket']);
    if (!res.ok) continue; // transient gh/API hiccup — keep polling within the cap
    let checks: Array<{ name: string; state?: string; bucket?: string }>;
    try {
      checks = JSON.parse(res.out);
    } catch {
      continue;
    }
    const failing = checks.filter(c => c.bucket === 'fail' || ['FAILURE', 'ERROR'].includes(c.state ?? '')).map(c => c.name);
    if (failing.length) return { verdict: 'red', failing };
    const pending = checks.filter(c => c.bucket === 'pending' || ['PENDING', 'IN_PROGRESS', 'QUEUED'].includes(c.state ?? ''));
    if (!pending.length) return { verdict: 'green', failing: [] };
  }
  return { verdict: 'timeout', failing: [] };
}

function main(): void {
  const argv = process.argv.slice(2);
  const branch = argv.find(a => !a.startsWith('--'));
  const titleIdx = argv.indexOf('--title');
  const bodyIdx = argv.indexOf('--body-file');
  const title = titleIdx >= 0 ? argv[titleIdx + 1] : undefined;
  const bodyFile = bodyIdx >= 0 ? argv[bodyIdx + 1] : undefined;
  if (!branch) fail(2, { detail: 'usage: autoloop-seal.ts <batchBranch> [--title T] [--body-file F]' });

  // Preconditions: clean tree, batch branch exists.
  if (sh('git', ['status', '--porcelain'])) fail(2, { detail: 'working tree is dirty — refusing to seal' });
  if (!shSafe('git', ['rev-parse', '--verify', branch!]).ok) fail(2, { detail: `batch branch not found: ${branch}` });

  sh('git', ['fetch', 'origin', '--quiet']);
  const oldMain = sh('git', ['rev-parse', 'origin/main']);

  // Push with --no-verify (structural: skip the slow/flaky local pre-push hook; CI is the gate).
  sh('git', ['checkout', branch!]);
  const push = shSafe('git', ['push', '--no-verify', '-u', 'origin', branch!]);
  if (!push.ok) fail(2, { detail: `push failed: ${push.out.slice(0, 500)}` });

  // Find or create the PR.
  let pr = Number(shSafe('gh', ['pr', 'list', '--head', branch!, '--state', 'open', '--json', 'number', '--jq', '.[0].number']).out || 0);
  if (!pr) {
    const prTitle = title ?? sh('git', ['log', '-1', '--format=%s', branch!]);
    const args = ['pr', 'create', '--base', 'main', '--head', branch!, '--title', prTitle];
    if (bodyFile) args.push('--body-file', bodyFile);
    else args.push('--body', `Autoloop batch seal for \`${branch}\`.`);
    const created = shSafe('gh', args);
    if (!created.ok) fail(2, { detail: `pr create failed: ${created.out.slice(0, 500)}` });
    pr = Number(shSafe('gh', ['pr', 'list', '--head', branch!, '--state', 'open', '--json', 'number', '--jq', '.[0].number']).out || 0);
    if (!pr) fail(2, { detail: 'PR created but could not resolve its number' });
  }

  // Watch CI — hard-capped poll, always returns.
  const ci = watchCi(pr);
  if (ci.verdict === 'red') fail(3, { pr, detail: `CI red: ${ci.failing.join(', ')}`, failing: ci.failing });
  if (ci.verdict === 'timeout') fail(3, { pr, detail: 'CI did not resolve within the poll cap', failing: [] });

  // Merge on green.
  const merge = shSafe('gh', ['pr', 'merge', String(pr), '--merge', '--delete-branch']);
  if (!merge.ok) fail(2, { pr, detail: `merge failed (conflict?): ${merge.out.slice(0, 500)}` });
  sh('git', ['checkout', 'main']);
  sh('git', ['pull', '--ff-only', '--quiet']);
  const newSha = sh('git', ['rev-parse', '--short', 'HEAD']);

  // Compute path-mandated files from the merged diff.
  const changed = sh('git', ['diff', '--name-only', `${oldMain}..HEAD`]).split('\n').filter(Boolean);
  const pathMandated = changed.filter(isPathMandated);

  emit({
    ok: true,
    pr,
    sha: newSha,
    pathMandated,
    boxVerifyOwed: pathMandated.length > 0,
    detail: pathMandated.length
      ? `Merged PR #${pr} → ${newSha}; box_verify=owed (path-mandated: ${pathMandated.join(', ')})`
      : `Merged PR #${pr} → ${newSha}; nothing path-mandated (box_verify stays clear unless a unit's gate=verify)`,
  });
}

// Only run when invoked directly (so tests can import isPathMandated purely).
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('autoloop-seal.ts') || invokedPath.endsWith('autoloop-seal.js')) {
  main();
}
