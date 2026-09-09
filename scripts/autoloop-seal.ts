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
 * The CI verdict is POSITIVE (#2938): green needs every check to be a pass or an
 * explicit skip and the list to be non-empty — a `cancel` or any bucket this
 * script does not know is NOT a pass. `main` is not branch-protected, so this is
 * the only gate before `release.yml` fires. The box-verify gate has a third
 * state (#2939): "could not be computed" resolves to OWED, never to clear.
 *
 * Exit codes: 0 merged; 3 CI red (result carries the failing checks — LLM
 * decides fix-forward); 2 setup error (dirty tree, bad branch, merge conflict).
 * EVERY exit path prints exactly one AUTOLOOP_SEAL_RESULT line.
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
// Each signature is additionally SCOPED to the paths the effect is about
// (`EFFECT_SCOPES`): a marker is a literal string, so unscoped it fires on any
// file that merely *mentions* it. That is #2829 — the seal of PR #2827 reported
// `template-schema-migration @ scripts/autoloop-verify-classify.ts` (a
// classifier that greps template YAML) and charged the batch a false ~25 min
// `:dev` verify while nothing under `templates/` had changed at all.
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

/**
 * WHERE each effect can actually happen — the path axis of the marker match.
 * A template migration only exists under `templates/`; the secret-store and
 * installed-manifest writes are app code that ships under `packages/`. A
 * playbook, a doc, a script or a test that spells the marker out is *describing*
 * the effect, not having it (#2829).
 */
const EFFECT_SCOPES: Record<DurableEffectKind, RegExp> = {
  'template-schema-migration': /^templates\//,
  'secret-store-write': /^packages\//,
  'installed-manifest-write': /^packages\//,
};

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
        if (!EFFECT_SCOPES[m.kind].test(file)) continue; // a literal match outside the effect's own tree (#2829)
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

// ---------------------------------------------------------------------------
// The CI verdict (#2938) — POSITIVE proof, never inferred from an absence.
// ---------------------------------------------------------------------------
//
// The old verdict was "not in the fail set and not in the pending set ⇒ green".
// `gh pr checks --json bucket` emits FIVE buckets, so a `cancel` sat in neither
// filter and read as green — and `main` is not branch-protected (release-please
// owns it), so `watchCi` is the only thing between a half-run CI and a push to
// `main` that fires `release.yml`. Cancellation is routine here:
// `.github/workflows/ci.yml` sets `cancel-in-progress: true`.
//
// So the verdict is now derived from what a check IS, not from what it is not:
// green requires every check to be positively a pass (or an explicit skip) AND
// the list to be non-empty. Anything else — `cancel`, a bucket gh adds next
// year, a check with no bucket and an unrecognised state — is NOT PASSED.

/** Every bucket `gh pr checks --json bucket` can emit today. Enumerated so the
 *  test can assert the whole class rather than the one case that bit us — a new
 *  bucket must be classified here deliberately, not discovered by a bad merge. */
export const GH_CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;

/** …of which ONLY these mean "this check actually passed". `skipping` is an
 *  explicit "this check does not apply", which is a decision, not a failure. */
export const PASSING_BUCKETS: ReadonlySet<string> = new Set(['pass', 'skipping']);

/** …and only these mean "not resolved yet, keep polling". */
export const PENDING_BUCKETS: ReadonlySet<string> = new Set(['pending']);

/** The legacy `state` field, used only when a check carries no bucket at all. */
const PASSING_STATES: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_STATES: ReadonlySet<string> = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'EXPECTED']);

export interface CiCheck {
  name: string;
  state?: string;
  bucket?: string;
}

/** What one check proves. `not-passed` is the catch-all on purpose: an
 *  unrecognised bucket/state is never evidence of a pass. */
export function classifyCheck(check: CiCheck): 'passed' | 'pending' | 'not-passed' {
  const bucket = check.bucket;
  if (bucket) {
    if (PASSING_BUCKETS.has(bucket)) return 'passed';
    if (PENDING_BUCKETS.has(bucket)) return 'pending';
    return 'not-passed';
  }
  const state = check.state ?? '';
  if (PASSING_STATES.has(state)) return 'passed';
  if (PENDING_STATES.has(state)) return 'pending';
  return 'not-passed';
}

export type CiVerdict = 'green' | 'red' | 'pending';

/** Pure: the verdict for one `gh pr checks` payload. Exported so the whole
 *  bucket class is unit-tested without a network or a PR.
 *  - `green`   every check passed (or was explicitly skipped) and there is at
 *              least one check — an empty list proves nothing.
 *  - `red`     at least one check is positively not-passed (fail, cancel, an
 *              unknown bucket). Reported even when others are still pending: a
 *              cancelled check will never become a pass.
 *  - `pending` nothing is not-passed yet, but something is unresolved (or the
 *              list is still empty) — the caller keeps polling within its cap. */
export function ciVerdict(checks: readonly CiCheck[]): { verdict: CiVerdict; failing: string[] } {
  if (!checks.length) return { verdict: 'pending', failing: [] };
  const failing: string[] = [];
  let pending = 0;
  for (const check of checks) {
    const cls = classifyCheck(check);
    if (cls === 'passed') continue;
    if (cls === 'pending') {
      pending++;
      continue;
    }
    failing.push(`${check.name || '<unnamed>'} [${check.bucket || check.state || 'no bucket/state'}]`);
  }
  if (failing.length) return { verdict: 'red', failing };
  if (pending) return { verdict: 'pending', failing: [] };
  return { verdict: 'green', failing: [] };
}

/** Poll CI for the PR in a HARD-CAPPED loop that always returns.
 *  → 'green' (every check positively passed), 'red' (a check is not a pass), or
 *  'timeout'. Never an unbounded wait — this is the anti-wedge core. */
function watchCi(pr: number, maxPolls = 20, intervalSec = 30): { verdict: 'green' | 'red' | 'timeout'; failing: string[] } {
  for (let i = 0; i < maxPolls; i++) {
    sh('sleep', [String(intervalSec)]);
    const res = shSafe('gh', ['pr', 'checks', String(pr), '--json', 'name,state,bucket']);
    if (!res.ok) continue; // transient gh/API hiccup — keep polling within the cap
    let checks: CiCheck[];
    try {
      checks = JSON.parse(res.out);
    } catch {
      continue;
    }
    if (!Array.isArray(checks)) continue;
    const decided = ciVerdict(checks);
    if (decided.verdict !== 'pending') return { verdict: decided.verdict, failing: decided.failing };
  }
  return { verdict: 'timeout', failing: [] };
}

/** Decide box-verify for a merged range, on BOTH axes: place (the directory
 *  list) and effect (does it write/migrate persisted state — #2700).
 *
 *  THROWS when it cannot decide (#2939). The caller turns a throw into the
 *  distinct "not computed" state, which resolves to OWED — never into the
 *  optimistic "computed, nothing owed". The `git diff --name-only` is
 *  deliberately the throwing `sh`: an unresolvable rev (the `--delete-branch`
 *  pruned the tip, HEAD sits on the deleted branch) must be loud, not silently
 *  read as an empty change set. */
function gateForRange(from: string, to: string): GateDecision {
  const changedPaths = sh('git', ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean);
  // A merge always ships files. An empty list is not evidence that nothing is
  // owed — it means the range told us nothing (wrong revs, a pruned tip). Check
  // the denominator before trusting the verdict.
  if (!changedPaths.length) {
    throw new Error(`git diff listed no changed files for ${from}..${to} — the gate has no evidence to decide on`);
  }
  // `--unified=0` keeps this to the added lines themselves. If the read fails
  // (huge diff, binary-only), we degrade to the path-keyed rules rather than
  // aborting a completed merge.
  const diffRead = shSafe('git', ['diff', '--unified=0', '--no-color', `${from}..${to}`]);
  const added = diffRead.ok ? parseAddedLines(diffRead.out) : new Map<string, string[]>();
  return gateDecision(changedPaths.map(path => ({ path, addedLines: added.get(path) ?? [] })));
}

/**
 * Pure: the machine-readable result line for a merged seal. `gate === null` is
 * the "could not be computed" state (#2939) and resolves to OWED — the emitted
 * result says WHICH of the two it is, so the orchestrator (which folds the
 * field, not the warning) cannot read an uncomputed gate as a clean one.
 * Exported so that resolution is asserted without a subprocess.
 */
export function mergedResult(args: {
  pr: number;
  sha: string;
  gate: GateDecision | null;
  postMergeWarning?: string;
}): Record<string, unknown> {
  const { pr, sha, gate, postMergeWarning } = args;
  const gateComputed = gate !== null;
  const boxVerifyOwed = gate === null || gate.boxVerifyOwed;
  let detail: string;
  if (gate === null) {
    detail = `Merged PR #${pr} → ${sha}; box_verify=owed — THE GATE COULD NOT BE COMPUTED, so it is owed rather than clear (${postMergeWarning ?? 'no detail'})`;
  } else if (gate.boxVerifyOwed) {
    detail = `Merged PR #${pr} → ${sha}; box_verify=owed (${gate.detail})`;
  } else {
    detail = `Merged PR #${pr} → ${sha}; neither path-mandated nor a durable-state effect (box_verify stays clear unless a unit's gate=verify)`;
  }
  return {
    ok: true,
    pr,
    sha,
    gateComputed,
    pathMandated: gate?.pathMandated ?? [],
    effects: gate?.effects ?? [],
    boxVerifyOwed,
    ...(postMergeWarning ? { postMergeWarning } : {}),
    detail,
  };
}

/**
 * Post-merge fold (#2761). The PR is MERGED, so every step here is best-effort
 * and the result line is printed from a `finally`: the orchestrator needs
 * sha/pathMandated/boxVerifyOwed to fold the verify state, and losing them to a
 * throttled `git pull` meant folding it by hand. Failures become
 * `postMergeWarning`, never a non-zero exit. Only the VERDICT fails closed
 * (#2939): a failed checkout/pull/sha lookup is still just a warning and still
 * exit 0 — what changed is that an uncomputed gate cannot be folded as clean.
 */
function foldMerged(pr: number, oldMain: string, batchTip: string): void {
  const warnings: string[] = [];
  let newSha = '';
  // `null` is the THIRD state (#2939): not "nothing is owed", but "the gate did
  // not get to run". It is deliberately NOT the optimistic `boxVerifyOwed:false`
  // initialiser the old code emitted from the `finally` after a throw — an
  // uncomputed gate resolved to a clean verdict, and the orchestrator folds the
  // machine-readable field, not the warning.
  let gate: GateDecision | null = null;
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
    emit(mergedResult({ pr, sha: newSha, gate, postMergeWarning: warnings.length ? warnings.join('; ') : undefined }));
  }
}

/**
 * Preconditions + push, up to the point where a PR can exist. Returns the
 * pre-merge `origin/main` — the `from` of the gate's range.
 *
 * Every git call is `shSafe` + an explicit `fail(2, …)` rather than the throwing
 * `sh` (#2938): the documented contract is one AUTOLOOP_SEAL_RESULT line on
 * EVERY exit path, and an orchestrator handed a bare stack trace has to fold the
 * batch by hand.
 */
function pushBatch(branch: string): string {
  const status = shSafe('git', ['status', '--porcelain']);
  if (!status.ok) fail(2, { detail: `git status failed: ${status.out.slice(0, 300)}` });
  if (status.out) fail(2, { detail: 'working tree is dirty — refusing to seal' });
  if (!shSafe('git', ['rev-parse', '--verify', branch]).ok) fail(2, { detail: `batch branch not found: ${branch}` });

  // Pre-merge fetch: a failure here means nothing shipped, but it still has to
  // leave a result line rather than an uncaught throw (#2761).
  const fetched = shSafe('git', ['fetch', 'origin', '--quiet']);
  if (!fetched.ok) fail(2, { detail: `git fetch failed: ${fetched.out.slice(0, 500)}` });
  const oldMain = shSafe('git', ['rev-parse', 'origin/main']);
  if (!oldMain.ok || !oldMain.out) fail(2, { detail: `cannot resolve origin/main: ${oldMain.out.slice(0, 300)}` });

  // A checkout can legitimately fail — most often the batch branch is already
  // checked out in another worktree — and that must exit 2 WITH a result line.
  const checkedOut = shSafe('git', ['checkout', branch]);
  if (!checkedOut.ok) fail(2, { detail: `git checkout ${branch} failed (checked out in another worktree?): ${checkedOut.out.slice(0, 300)}` });
  // Push with --no-verify (structural: skip the slow/flaky local pre-push hook; CI is the gate).
  const push = shSafe('git', ['push', '--no-verify', '-u', 'origin', branch]);
  if (!push.ok) fail(2, { detail: `push failed: ${push.out.slice(0, 500)}` });
  return oldMain.out;
}

/** Find the open PR for the batch branch, or create it. */
function resolvePr(branch: string, title: string | undefined, bodyFile: string | undefined): number {
  const openPr = () =>
    Number(shSafe('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number']).out || 0);
  const existing = openPr();
  if (existing) return existing;
  const prTitle = title ?? (shSafe('git', ['log', '-1', '--format=%s', branch]).out || `Autoloop batch seal for ${branch}`);
  const args = ['pr', 'create', '--base', 'main', '--head', branch, '--title', prTitle];
  if (bodyFile) args.push('--body-file', bodyFile);
  else args.push('--body', `Autoloop batch seal for \`${branch}\`.`);
  const created = shSafe('gh', args);
  if (!created.ok) fail(2, { detail: `pr create failed: ${created.out.slice(0, 500)}` });
  const pr = openPr();
  if (!pr) fail(2, { detail: 'PR created but could not resolve its number' });
  return pr;
}

function main(): void {
  const argv = process.argv.slice(2);
  const branch = argv.find(a => !a.startsWith('--'));
  const titleIdx = argv.indexOf('--title');
  const bodyIdx = argv.indexOf('--body-file');
  const title = titleIdx >= 0 ? argv[titleIdx + 1] : undefined;
  const bodyFile = bodyIdx >= 0 ? argv[bodyIdx + 1] : undefined;
  if (!branch) fail(2, { detail: 'usage: autoloop-seal.ts <batchBranch> [--title T] [--body-file F]' });

  const oldMain = pushBatch(branch!);
  const pr = resolvePr(branch!, title, bodyFile);

  // Watch CI — hard-capped poll, always returns.
  const ci = watchCi(pr);
  if (ci.verdict === 'red') fail(3, { pr, detail: `CI red: ${ci.failing.join(', ')}`, failing: ci.failing });
  if (ci.verdict === 'timeout') fail(3, { pr, detail: 'CI did not resolve within the poll cap', failing: [] });

  // The batch tip, captured BEFORE the merge: `--delete-branch` drops the local
  // ref, and this range (oldMain..batchTip) is exactly what the merge shipped —
  // so the gate still computes when the post-merge pull is throttled (#2761).
  const tip = shSafe('git', ['rev-parse', branch!]);
  if (!tip.ok || !tip.out) fail(2, { pr, detail: `cannot resolve the batch tip ${branch} before merging: ${tip.out.slice(0, 300)}` });
  const batchTip = tip.out;

  // Merge on green.
  const merge = shSafe('gh', ['pr', 'merge', String(pr), '--merge', '--delete-branch']);
  if (!merge.ok) fail(2, { pr, detail: `merge failed (conflict?): ${merge.out.slice(0, 500)}` });

  foldMerged(pr, oldMain, batchTip);
}

// Only run when invoked directly (so tests can import isPathMandated purely).
// The catch is STRUCTURAL, not decorative: the contract is "every exit path
// carries an AUTOLOOP_SEAL_RESULT line", and an orchestrator that gets a bare
// stack trace has to fold the batch by hand (#2938). `fail()` uses
// `process.exit`, which does not throw, so it is never swallowed here.
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('autoloop-seal.ts') || invokedPath.endsWith('autoloop-seal.js')) {
  try {
    main();
  } catch (e) {
    fail(2, { detail: `seal aborted: ${redactGitSecrets(String((e as Error)?.message ?? e)).slice(0, 500)}` });
  }
}
