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
 *   AUTOLOOP_SEAL_RESULT {"ok":true,"pr":123,"sha":"abc1234","pathMandated":[...],"effects":[...],"boxVerifyOwed":true,"detail":"..."}
 *
 * Once the PR is MERGED that line is printed from a `finally` and every
 * post-merge git step is best-effort (a failure shows up as `postMergeWarning`,
 * not a non-zero exit) — a throttled `git pull` used to lose the whole result
 * after a successful merge (#2761). All git calls carry `gitEnv()` so the token
 * goes out proactively; see scripts/autoloop-git.ts.
 *
 * `boxVerifyOwed` is decided on TWO axes (#2700): the *place* the change lives
 * (`PATH_MANDATED_PATHS`) and the *effect* it has (`durableStateEffects` —
 * anything that writes or migrates persisted state). See `gateDecision`.
 *
 * Exit codes: 0 merged; 3 CI red (result carries the failing checks — LLM
 * decides fix-forward); 2 setup error (dirty tree, bad branch, merge conflict).
 */

import { execFileSync } from 'node:child_process';
import { gitEnv, redactGitSecrets } from './autoloop-git';

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
  // the /napi companion surface — token-scoped, proxy-bypassed routes the
  // Solaris app calls (read + mutating operate/upgrade/approvals). A change
  // here must box-verify on the real device path (#2313 dogfood found this
  // gap — it was only caught by gate=verify before).
  'packages/frontend/src/app/napi/',
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

// ---------------------------------------------------------------------------
// The EFFECT axis (#2700) — what the change does, not where the file sits.
// ---------------------------------------------------------------------------
//
// `PATH_MANDATED_PATHS` above gates by *place*. That reaches different verdicts
// for identical work: the claude-dev schema 2->3 bump shipped
// `templates/claude-dev/migrations/v2-to-v3.py` — a data migration that runs
// against every installed copy of the service — and not one of its files sits
// in the list above, so the path gate said "nothing owed".
//
// The right axis was already first-class in this repo one layer over: the
// permission ladder (`packages/backend/src/lib/auth/apiScope.ts`,
// `docs/SCOPE_AUDIT.md`) separates `reboot` (transient, recoverable) from
// `destroy` (irreversible state edits). This is that same reversibility test,
// transferred from the runtime layer to the release layer:
//
//   **Does this change write or migrate state that outlives the release?**
//   If yes, a real box-verify is owed — whatever directory it lives in.
//
// It must be NAMEABLE, not a matter of judgement, or it is not scriptable. So
// the trigger is a closed list of three signatures, each with a concrete
// irreversible consequence on the box:
//
//   template-schema-migration  an upgrade script under `templates/*/migrations/`,
//                              or a `servicebay.schema-version` bump — rewrites
//                              installed services' data/pod layout on upgrade.
//   secret-store-write         the saved-secrets store's key file or on-disk
//                              envelope — rotate or re-shape it and previously
//                              stored secrets stop decrypting.
//   installed-manifest-write   an assignment into `config.installedTemplates` —
//                              the record of what is installed at what schema
//                              version; a wrong write strands services.
//
// Keep both gates: the directory list still covers non-migration cases (the
// proxy/forward-auth render, the /napi surface, the user-facing dashboards).
// What changed is that a migration no longer *depends* on it.

/** One changed file, with the lines the change ADDED. */
export interface ChangedFile {
  /** repo-relative path */
  path: string;
  /** Unified-diff `+` lines with the prefix stripped. Omit (or leave empty)
   *  and only the path-keyed rules apply to this file — so a diff we could not
   *  read degrades to the old, place-only gate instead of failing open loudly. */
  addedLines?: readonly string[];
}

export type DurableEffectKind =
  | 'template-schema-migration'
  | 'secret-store-write'
  | 'installed-manifest-write';

export interface DurableStateEffect {
  kind: DurableEffectKind;
  path: string;
  detail: string;
}

/** A template upgrade script: `templates/<name>/migrations/v2-to-v3.py`. It runs
 *  against the installed service's own data — the migration itself. */
export const TEMPLATE_UPGRADE_SCRIPT = /^templates\/[^/]+\/migrations\/v\d+-to-v\d+\.[a-z]+$/;

/** Added lines that mean "persisted state moves". Each entry is a signature we
 *  can name, so the gate stays scriptable rather than a judgement call. */
const EFFECT_MARKERS: ReadonlyArray<{ kind: DurableEffectKind; re: RegExp; detail: string }> = [
  {
    kind: 'template-schema-migration',
    re: /servicebay\.schema-version/,
    detail: 'template schema-version annotation moved — installed services get migrated on upgrade',
  },
  {
    kind: 'secret-store-write',
    re: /\bregenerateSecretKey\s*\(|\bSECRET_KEY_PATH\b|['"`]secret\.key['"`]/,
    detail: 'saved-secrets key material — rotating it makes every stored secret undecryptable',
  },
  {
    kind: 'secret-store-write',
    re: /['"`]enc:['"`]/,
    detail: 'saved-secrets on-disk envelope prefix — re-shaping it rewrites the stored form',
  },
  {
    kind: 'installed-manifest-write',
    re: /\binstalledTemplates\s*(\[[^\]]*\])?(\.[A-Za-z_$][\w$]*)*\s*=[^=]|\bdelete\s+[\w.]*installedTemplates\s*\[/,
    detail: 'writes config.installedTemplates — the record of what is installed at which schema version',
  },
];

/** Files that *describe* an effect rather than *have* one on the box: tests and
 *  fixtures, prose (a `.md` cannot migrate anything), and this file — the gate's
 *  own definition necessarily spells out every marker it looks for, and must not
 *  match itself. Everything else is fair game, wherever it lives. */
function isNonShipping(file: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)tests?\//.test(file) ||
    /(^|\/)__(tests|mocks|pycache)__\//.test(file) ||
    /\.md$/.test(file) ||
    file === 'scripts/autoloop-seal.ts'
  );
}

/** Pure: which durable-state effects does this change set carry? Exported so the
 *  classification is unit-tested without git. */
export function durableStateEffects(changed: readonly ChangedFile[]): DurableStateEffect[] {
  const out: DurableStateEffect[] = [];
  for (const { path: file, addedLines } of changed) {
    if (isNonShipping(file)) continue;
    if (TEMPLATE_UPGRADE_SCRIPT.test(file)) {
      out.push({
        kind: 'template-schema-migration',
        path: file,
        detail: 'template upgrade script — runs against installed services\' data',
      });
    }
    for (const line of addedLines ?? []) {
      for (const m of EFFECT_MARKERS) {
        if (m.re.test(line) && !out.some(e => e.path === file && e.kind === m.kind)) {
          out.push({ kind: m.kind, path: file, detail: m.detail });
        }
      }
    }
  }
  return out;
}

export interface GateDecision {
  pathMandated: string[];
  effects: DurableStateEffect[];
  boxVerifyOwed: boolean;
  detail: string;
}

/** THE gate. Place OR effect — either one owes a real on-box verify. */
export function gateDecision(changed: readonly ChangedFile[]): GateDecision {
  const pathMandated = changed.map(c => c.path).filter(isPathMandated);
  const effects = durableStateEffects(changed);
  const parts: string[] = [];
  if (pathMandated.length) parts.push(`path-mandated: ${pathMandated.join(', ')}`);
  if (effects.length) parts.push(`durable-state effect: ${effects.map(e => `${e.kind} @ ${e.path}`).join(', ')}`);
  return {
    pathMandated,
    effects,
    boxVerifyOwed: pathMandated.length > 0 || effects.length > 0,
    detail: parts.join('; '),
  };
}

/** Parse `git diff --unified=0` into per-file ADDED lines. Renames/binaries just
 *  yield no added lines — the path rules still cover them. Exported for tests. */
export function parseAddedLines(diffText: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ') || line.startsWith('@@')) continue;
    if (current && line.startsWith('+')) byFile.get(current)!.push(line.slice(1));
  }
  return byFile;
}

// ---- everything below runs only when invoked as a script ----

function sh(cmd: string, args: string[]): string {
  // maxBuffer well above the default 1 MiB: the merged-diff read below can be
  // large, and a truncation throw there would silently lose the effect axis.
  // `env: gitEnv()` sends the gh token proactively so GitHub's unauthenticated
  // download throttle can't kill a fetch/pull mid-seal (#2761).
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    }).trim();
  } catch (e) {
    const err = e as Error;
    err.message = redactGitSecrets(err.message ?? '');
    throw err;
  }
}
function shSafe(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: sh(cmd, args) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: redactGitSecrets(`${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim()) };
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

/** Decide box-verify for a merged range, on BOTH axes: place (the directory
 *  list) and effect (does it write/migrate persisted state — #2700). */
function gateForRange(from: string, to: string): GateDecision {
  const changedPaths = sh('git', ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean);
  // `--unified=0` keeps this to the added lines themselves. If the read fails
  // (huge diff, binary-only), we degrade to the path-keyed rules rather than
  // aborting a completed merge.
  const diffRead = shSafe('git', ['diff', '--unified=0', '--no-color', `${from}..${to}`]);
  const added = diffRead.ok ? parseAddedLines(diffRead.out) : new Map<string, string[]>();
  return gateDecision(changedPaths.map(path => ({ path, addedLines: added.get(path) ?? [] })));
}

/**
 * Post-merge fold (#2761). The PR is MERGED, so every step here is best-effort
 * and the result line is printed from a `finally`: the orchestrator needs
 * sha/pathMandated/boxVerifyOwed to fold the verify state, and losing them to a
 * throttled `git pull` meant folding it by hand. Failures become
 * `postMergeWarning`, never a non-zero exit.
 */
function foldMerged(pr: number, oldMain: string, batchTip: string): void {
  const warnings: string[] = [];
  let newSha = '';
  let gate: GateDecision = { pathMandated: [], effects: [], boxVerifyOwed: false, detail: '' };
  try {
    const checkout = shSafe('git', ['checkout', 'main']);
    if (!checkout.ok) warnings.push(`git checkout main failed: ${checkout.out.slice(0, 300)}`);
    const pull = shSafe('git', ['pull', '--ff-only', '--quiet']);
    if (!pull.ok) warnings.push(`git pull --ff-only failed: ${pull.out.slice(0, 300)}`);

    // sha for the verify fold: local HEAD when the pull landed, else the merge
    // commit straight from the API (gh always authenticates, so it survives the
    // throttle), else the batch tip.
    const head = checkout.ok && pull.ok ? shSafe('git', ['rev-parse', '--short', 'HEAD']) : { ok: false, out: '' };
    if (head.ok && head.out) newSha = head.out;
    else {
      const api = shSafe('gh', ['pr', 'view', String(pr), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
      newSha = api.ok && api.out ? api.out.slice(0, 7) : batchTip.slice(0, 7);
    }

    gate = gateForRange(oldMain, batchTip);
  } catch (e) {
    warnings.push(redactGitSecrets(String((e as Error)?.message ?? e)).slice(0, 300));
  } finally {
    const postMergeWarning = warnings.length ? warnings.join('; ') : undefined;
    emit({
      ok: true,
      pr,
      sha: newSha,
      pathMandated: gate.pathMandated,
      effects: gate.effects,
      boxVerifyOwed: gate.boxVerifyOwed,
      ...(postMergeWarning ? { postMergeWarning } : {}),
      detail: gate.boxVerifyOwed
        ? `Merged PR #${pr} → ${newSha}; box_verify=owed (${gate.detail})`
        : `Merged PR #${pr} → ${newSha}; neither path-mandated nor a durable-state effect (box_verify stays clear unless a unit's gate=verify)`,
    });
  }
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

  // Pre-merge fetch: a failure here means nothing shipped, but it still has to
  // leave a result line rather than an uncaught throw (#2761).
  const fetched = shSafe('git', ['fetch', 'origin', '--quiet']);
  if (!fetched.ok) fail(2, { detail: `git fetch failed: ${fetched.out.slice(0, 500)}` });
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

  // The batch tip, captured BEFORE the merge: `--delete-branch` drops the local
  // ref, and this range (oldMain..batchTip) is exactly what the merge shipped —
  // so the gate still computes when the post-merge pull is throttled (#2761).
  const batchTip = sh('git', ['rev-parse', branch!]);

  // Merge on green.
  const merge = shSafe('gh', ['pr', 'merge', String(pr), '--merge', '--delete-branch']);
  if (!merge.ok) fail(2, { pr, detail: `merge failed (conflict?): ${merge.out.slice(0, 500)}` });

  foldMerged(pr, oldMain, batchTip);
}

// Only run when invoked directly (so tests can import isPathMandated purely).
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('autoloop-seal.ts') || invokedPath.endsWith('autoloop-seal.js')) {
  main();
}
