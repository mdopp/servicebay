/**
 * `:dev` flip-verify-flipback harness for box-verify (#2306 slice 3).
 *
 * The FULL box-verify path — pre-pull `:dev`, wait for the image, flip, run the
 * probes, **flip back to `:latest`** — is deterministic *except* the probes
 * (what to assert is LLM judgment). The load-bearing invariant is "never leave
 * the box stranded on `:dev`". In prose that's an advisory rule a stage agent
 * can skip on an error path; here it is a `finally` — **structural**. The agent
 * supplies its probes as a script; the harness guarantees the flip-back even if
 * the probes throw, hang, or the agent dies (CLAUDE.md "Deterministic → scripts;
 * LLMs coordinate + evaluate").
 *
 * Both flips are MCP `set_channel` calls authorized by the `sb_` token (#2532) —
 * the harness never obtains an admin session and never reads credentials off the
 * box. That also *strengthens* the never-stranded invariant: out and back are the
 * same call with the same static authority, so a box the harness can flip to
 * `:dev` is by construction a box it can flip back.
 *
 *   tsx scripts/autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900]
 *     [--flipback-timeout 900] [--push-timeout 900] [--assume-pushed]
 *   tsx scripts/autoloop-dev-verify.ts --recover      # repair an abandoned flip
 *
 * **The `finally` is not enough when the CONTAINER dies (#2826).** The
 * orchestrator and this harness run *inside* the `claude-dev` container on the
 * box, so a FULL verify whose probes upgrade/restart that service recreate the
 * container mid-flip and kill the harness's whole process tree — no `finally`,
 * no flip-back, box left on `:dev` (2026-09-05, 17:23Z→17:54Z). Detaching the
 * child (`setsid`/`spawn({detached})`) does not help either: the detached child
 * dies with the container too. So the flip-back guarantee is extended with
 * state that outlives the container: the run writes an **in-flight marker**
 * (`.claude/state/dev-verify-inflight.json`, on the persistent `/workspace`
 * volume) *before* the flip POST and drops it only once the flip-back is
 * CONFIRMED, and `--recover` — wired into the orchestrator's Step 0 preflight —
 * reads that marker plus `get_channel` and flips a `:dev` box back to `:latest`
 * whenever no live harness owns the flip.
 *
 * The probe script runs while the box is on `:dev @ <sha>`; its stdout/stderr +
 * exit code are captured and returned. Emits one machine-readable last line:
 *   AUTOLOOP_DEV_VERIFY_RESULT {"reachedDev":true,"probeExit":0,"flippedBack":true,"channel":"latest",
 *                               "devImage":{"revision":"…","reads":3,"readFailures":1,"detail":"…"},
 *                               "devPush":{"runId":123,"status":"completed","conclusion":"success","detail":"…"},
 *                               "flipTimeout":null,"failure":null,"probeOutput":"…"}
 *
 * **Nothing is flipped until the SHA's `:dev` image is actually on the registry
 * (#2820).** The old first step was the flip, so a run started minutes after the
 * merge pulled the *previous* `:dev` digest, then watched the wrong build for the
 * whole 900s image budget and reported `reachedDev:false`. The run now waits for
 * this SHA's `Release` workflow run to reach `completed`/`success` first, bounded
 * by `--push-timeout` (`--assume-pushed` skips it for a re-run of a SHA already
 * on the registry); "the image was never pushed" is its own named failure step,
 * `dev-image-not-pushed`, never confused with `flip-to-dev`. The second half of
 * that same race: `set_channel dev` is awaited server-side through a multi-minute
 * `podman pull` while the client call times out after 30s — that timeout is
 * **pull-in-progress**, not a refusal, so the run keeps polling for the image
 * budget instead of flipping straight back (it is reported as `flipTimeout`).
 *
 * **The push wait resolves the SHA to its full 40-char form first (#2837).**
 * `gh run list --commit` matches exactly and answers a SHORT sha with an empty
 * array — not an error — so a run invoked the way the playbook documents it
 * (short sha) polled out the whole `--push-timeout` and reported
 * `dev-image-not-pushed` for an image that was already on the registry. The
 * resolution happens ONCE, before the poll loop (`resolveFullSha`); the running
 * image's revision label is still compared by prefix, so a short sha keeps
 * matching there as it always did.
 *
 * `reachedDev` and `flippedBack` are trustworthy on their own — both poll
 * through the whole restart window and carry their evidence (`devImage`,
 * `flipBack`), so no manual `list_containers`/image-tag cross-check is needed
 * (#2387, #2493).
 *
 * **Every failure carries a named reason (#2622).** A run that does not reach
 * `:dev` is exactly one of two shapes, told apart from the result line alone:
 *  - `failure:null` + a `devImage` object ⇒ the harness ran its full wait and the
 *    image never showed up (`devImage.detail` says which flavour — "still in
 *    flight" vs. "the box never answered a read").
 *  - `failure:{step,message}` ⇒ the run **aborted at a named step** (the flip
 *    POST was refused, `/mcp` was down, the probe capture blew up …). This used
 *    to be the blind case: the whole flip/confirm block sat in a `try` with a
 *    `finally` and **no `catch`**, and the `finally` called `process.exit()` —
 *    which discards the in-flight exception, so the run emitted `devImage:null`,
 *    `probeOutput:""` and no stderr at all, then exited early. `devImage:null`
 *    with no explanation is now impossible (`devVerifyResultLine` synthesises a
 *    reason if the shape ever regresses).
 *
 * **`channel` is the CONFIGURED channel** (MCP `get_channel`), not proof of what
 * is running: on 2026-08-25 it reported `latest` while the box was demonstrably
 * running `:dev @f42dac70`. Only the OCI revision label read off the *running*
 * container is authoritative, so `reachedDev` is derived from `devImage` and
 * never from `get_channel` — see the structural guard in the test file.
 *
 * Exit 0 = harness ran and flipped back (READ probeExit/probeOutput to judge
 * green/red — that's the LLM's job); exit 2 = harness failure (never reached
 * `:dev`, or aborted at a named step — read `failure`) but ALWAYS attempted
 * flip-back; exit 5 = flip-back FAILED (box may be stranded on :dev — hard
 * alert, orchestrator recovers).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getChannel, setChannel, waitHealth, mcpCall, mcpExec } from './autoloop-box';
import { gitEnv, resolveFullSha } from './autoloop-git';

/**
 * Does the running image's OCI revision label identify `sha`?
 *
 * The label (`org.opencontainers.image.revision`) is the **full 40-char git
 * SHA** baked into the image at build time. The harness usually knows the
 * **short** SHA, so we prefix-match: the label must START WITH the expected sha
 * (short or full). This is *not* a substring test — the earlier bug compared
 * the image TAG (`ghcr.io/mdopp/servicebay:dev`, which never contains a SHA),
 * so `:dev` alone must NOT count as a match. Exported for unit tests.
 */
export function revisionMatchesSha(revisionLabel: string, sha: string): boolean {
  const label = revisionLabel.trim().toLowerCase();
  const want = sha.trim().toLowerCase();
  // A git SHA is hex; guard against a tag string (e.g. "…:dev" or "dev")
  // sneaking through as a match. An empty want would prefix-match anything.
  if (!want || !/^[0-9a-f]{7,40}$/.test(want)) return false;
  if (!/^[0-9a-f]{7,40}$/.test(label)) return false;
  return label.startsWith(want);
}

/** A `list_containers` row, narrowed to the two fields this harness reads. */
export interface BoxContainerRow {
  names?: string[];
  labels?: Record<string, string>;
}

/**
 * The OCI revision label (full git SHA) of the running `servicebay` container.
 *
 * Read through the **`list_containers` read tool**, not `exec_command`: the
 * labels are already in that payload, the box-verify playbook mandates the
 * read-tool path, and it keeps the load-bearing `reachedDev` confirmation off
 * the `exec` scope entirely (#2623 — `destroy` no longer implies `exec`, so a
 * harness token without an explicit `exec` grant must still be able to judge
 * which image is running).
 *
 * `null` means **the read itself failed** — `/mcp` is served by the very app the
 * channel flip restarts, so a refused connection (or a list that momentarily
 * lacks the container) is expected mid-flip. That is categorically different
 * from a *successful* read returning a revision that isn't the target yet, and
 * the two must not collapse into one value: collapsing them is what made a
 * `reachedDev:false` verdict unreadable (#2493).
 *
 * This is the SHA baked into the image, NOT the tag (`image` is the tag name,
 * which never carries a SHA).
 */
async function runningRevision(): Promise<string | null> {
  try {
    const rows = await mcpCall<BoxContainerRow[]>('list_containers', {}, 20000);
    if (!Array.isArray(rows)) return null;
    return pickServicebayRevision(rows);
  } catch {
    return null; // /mcp unreachable (it lives in the app being restarted)
  }
}

/** Pull the `servicebay` container's revision label out of a `list_containers`
 *  payload. `null` = the container isn't in the list (mid-restart — a FAILED
 *  read, same class as no answer at all); `''` = it is there but its image
 *  carries no `org.opencontainers.image.revision` label. Exported for tests. */
export function pickServicebayRevision(rows: readonly BoxContainerRow[]): string | null {
  const row = rows.find(r => (r.names ?? []).includes('servicebay'));
  if (!row) return null;
  return (row.labels?.['org.opencontainers.image.revision'] ?? '').trim();
}

// ---------- :dev image confirmation (#2493) ----------

/** Box I/O the `:dev`-image confirmation needs, injected so the polling logic is
 *  unit-testable on a virtual clock without a real box. */
export interface DevImageDeps {
  /** Read the running container's OCI revision label. `null` = the read FAILED
   *  (mid-restart / `/mcp` down), NOT "the image has no/other revision". */
  readRevision: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface DevImageResult {
  reached: boolean;
  /** The last **successfully read** revision (`''` = image carries no label);
   *  `null` means the box never answered a single read within the budget. */
  revision: string | null;
  /** Successful reads vs. failed reads — the evidence behind the verdict. */
  reads: number;
  readFailures: number;
  detail: string;
}

export const DEV_IMAGE_TIMEOUT_SEC = 900;
const DEV_IMAGE_POLL_SEC = 10;

/**
 * Poll the running image's revision label until it identifies `sha`, bounded.
 *
 * Three defects made the old loop report `reachedDev:false` on a box whose
 * `:dev` image was demonstrably live moments later (#2493):
 *  1. **A blind trailing window.** The budget was checked at the top of the
 *     loop, so after the last fixed 20s sleep it returned `false` *without
 *     reading again* — an image that landed inside that window was never seen.
 *     Here the deadline is only a verdict **after** a read, so there is always a
 *     final observation at/after the deadline.
 *  2. **A failed read looked like a mismatched revision.** `''` was returned for
 *     both, so a run that never got one successful read (a box restarting for
 *     the whole budget, an unparseable `/mcp` reply) reported the same verdict —
 *     with a `detail` claiming "image build likely stuck" — as a genuinely stale
 *     image. Now they are counted separately and the verdict says which it was,
 *     so it is trustworthy without a manual `list_containers` cross-check.
 *  3. **A non-finite budget collapsed the loop to zero iterations** (`NaN`
 *     deadline ⇒ `Date.now() < NaN` is false ⇒ instant `false`). A bad/missing
 *     `--image-timeout` value is now rejected at parse time (`parseDevVerifyArgs`)
 *     and a non-finite budget here falls back to the default rather than
 *     silently skipping the wait.
 *
 * Only budget exhaustion *with a read in hand* is a verdict; every failed read
 * is "not yet", exactly like `confirmFlipBack`'s null/stale channel (#2387).
 */
export async function confirmDevImage(
  sha: string,
  deps: DevImageDeps,
  opts: { timeoutSec?: number; pollEverySec?: number } = {},
): Promise<DevImageResult> {
  const requested = opts.timeoutSec ?? DEV_IMAGE_TIMEOUT_SEC;
  const timeoutSec = Number.isFinite(requested) && requested > 0 ? requested : DEV_IMAGE_TIMEOUT_SEC;
  const pollEverySec = opts.pollEverySec ?? DEV_IMAGE_POLL_SEC;

  const deadline = deps.now() + timeoutSec * 1000;
  let revision: string | null = null;
  let reads = 0;
  let readFailures = 0;

  for (;;) {
    const observed = await deps.readRevision();
    if (observed === null) {
      readFailures++;
    } else {
      reads++;
      revision = observed;
      if (revisionMatchesSha(observed, sha)) {
        return {
          reached: true,
          revision: observed,
          reads,
          readFailures,
          detail: `:dev image with revision ${observed} live after ${reads} read(s), ${readFailures} failed read(s)`,
        };
      }
    }
    // The budget is a verdict only AFTER a read — never in the blind window
    // between the last poll and the deadline.
    if (deps.now() >= deadline) break;
    await deps.sleep(Math.min(pollEverySec * 1000, deadline - deps.now()));
  }

  const spent = `${timeoutSec}s (${reads} read(s), ${readFailures} failed read(s))`;
  return {
    reached: false,
    revision,
    reads,
    readFailures,
    detail:
      reads === 0
        ? `never read the running image revision within ${spent} — the box did not answer, which is NOT evidence the :dev image is missing`
        : `running image revision ${revision === '' ? '(unlabelled)' : revision} never matched ${sha} within ${spent} — :dev build likely still in flight`,
  };
}

// ---------- flip-back confirmation (#2387) ----------

/** Box I/O the flip-back confirmation needs, injected so the retry/tolerance
 *  logic is unit-testable without a real box. Mirrors the `autoloop-box`
 *  helpers of the same names. */
export interface FlipBackDeps {
  setChannel: (target: 'latest') => Promise<void>;
  waitHealth: (timeoutSec: number) => Promise<boolean>;
  getChannel: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface FlipBackResult {
  flippedBack: boolean;
  /** The last channel the box *actually* reported. `null` means it never
   *  answered at all within the budget — a genuinely unreachable box, not a
   *  transient read during a restart. */
  channel: string | null;
  /** How many times the flip POST was (re-)issued, and how many times the
   *  channel was polled — diagnostics for the emitted result line. */
  reissues: number;
  polls: number;
  detail: string;
}

/** Defaults: at least as generous as the flip-to-`:dev` side of the run
 *  (`waitHealth(180)` + `waitForDevImage(900)` + `waitHealth(180)`). */
export const FLIP_BACK_TIMEOUT_SEC = 900;
const FLIP_BACK_REISSUE_SEC = 180;
const FLIP_BACK_POLL_SEC = 15;
const FLIP_BACK_HEALTH_SEC = 180;

/**
 * Flip the box back to `:latest` and **confirm** it, tolerating the whole
 * restart-in-progress window (#2387).
 *
 * The old shape was 3 fast rounds of `setChannel → waitHealth(180) →
 * getChannel`, each round treating one bad read as a verdict. That produced
 * false `flippedBack:false` hard alerts on a box that had genuinely landed on
 * `:latest`, because mid-restart the box lies in two distinct ways:
 *  - `getChannel()` returns `null` (connection refused / 5xx while the new
 *    container comes up), and
 *  - `getChannel()` returns the **stale** `"dev"` (the outgoing container still
 *    answers `/api/system/channel` after the flip POST is accepted — and
 *    `waitHealth` happily reports "up" from that same outgoing container, so it
 *    provides no settle time at all).
 * Both were terminal in the old loop, and a `setChannel` throw (the flip call
 * against a restarting box) burned a whole round with **no** delay, so all three
 * rounds could be spent in seconds.
 *
 * Here neither shape is a verdict: they're "not yet". We poll `getChannel()`
 * until it reports `latest`, re-issuing the flip POST every
 * `reissueEverySec`, until the overall budget expires. Only budget exhaustion
 * is a verdict — so a box **genuinely stuck on `:dev`** still returns
 * `flippedBack:false` (with `channel:"dev"`), and a box that never answers at
 * all still returns `flippedBack:false` (with `channel:null`). Both keep exit 5
 * a trustworthy hard alert.
 */
export async function confirmFlipBack(
  deps: FlipBackDeps,
  opts: { timeoutSec?: number; reissueEverySec?: number; pollEverySec?: number; healthWaitSec?: number } = {},
): Promise<FlipBackResult> {
  const timeoutSec = opts.timeoutSec ?? FLIP_BACK_TIMEOUT_SEC;
  const reissueEverySec = opts.reissueEverySec ?? FLIP_BACK_REISSUE_SEC;
  const pollEverySec = opts.pollEverySec ?? FLIP_BACK_POLL_SEC;
  const healthWaitSec = opts.healthWaitSec ?? FLIP_BACK_HEALTH_SEC;

  const deadline = deps.now() + timeoutSec * 1000;
  let lastIssuedAt = Number.NEGATIVE_INFINITY;
  let channel: string | null = null;
  let reissues = 0;
  let polls = 0;

  while (deps.now() < deadline) {
    if (deps.now() - lastIssuedAt >= reissueEverySec * 1000) {
      lastIssuedAt = deps.now();
      try {
        await deps.setChannel('latest');
        reissues++;
      } catch {
        // The `set_channel` call against a restarting box throws (its /mcp
        // endpoint lives in the app being restarted). NOT a verdict — the
        // previous call may already have been accepted; keep confirming.
      }
      // Give the async restart room, bounded by what's left of the budget.
      const remainingSec = Math.ceil((deadline - deps.now()) / 1000);
      if (remainingSec > 0) await deps.waitHealth(Math.min(healthWaitSec, remainingSec));
    }

    polls++;
    const observed = await deps.getChannel();
    if (observed !== null) channel = observed; // remember the last REAL read
    if (observed === 'latest') {
      return { flippedBack: true, channel: 'latest', reissues, polls, detail: `confirmed :latest after ${polls} poll(s)` };
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(pollEverySec * 1000);
  }

  return {
    flippedBack: false,
    channel,
    reissues,
    polls,
    detail:
      channel === null
        ? `box never reported a channel within ${timeoutSec}s (${polls} poll(s), ${reissues} flip POST(s)) — may be stranded on :dev`
        : `box still reports :${channel} after ${timeoutSec}s (${polls} poll(s), ${reissues} flip POST(s)) — stranded on :${channel}`,
  };
}

// ---------- :dev image PUSH confirmation, before any flip (#2820) ----------

/** One `gh run list --json status,conclusion,databaseId` row. */
export interface ReleaseRunRow {
  databaseId?: number;
  status?: string;
  conclusion?: string;
}

/** The run that decides whether this SHA's `:dev` image exists. */
export interface ReleaseRunState {
  runId: number | null;
  status: string | null;
  conclusion: string | null;
}

/**
 * Pick the deciding `Release` run out of a `gh run list --commit <sha>` payload.
 *
 * A merge SHA can carry several runs (a re-run, a `workflow_dispatch` on top of
 * the push). One completed **success** means the `:dev` tag was pushed for this
 * SHA, whatever the others say — so a success wins outright; otherwise the newest
 * row (gh lists newest first) is the one still deciding. `null` = no run at all
 * yet, which is "not yet", never "it failed". Pure — exported for unit tests.
 */
export function pickReleaseRun(rows: readonly ReleaseRunRow[]): ReleaseRunState | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const success = rows.find(r => r.status === 'completed' && r.conclusion === 'success');
  const row = (success ?? rows[0]) as ReleaseRunRow;
  return {
    runId: typeof row.databaseId === 'number' ? row.databaseId : null,
    status: row.status ?? null,
    conclusion: row.conclusion ?? null,
  };
}

/** Registry I/O the push wait needs, injected so it is unit-testable on a
 *  virtual clock with no `gh` and no network. */
export interface DevPushDeps {
  /** The SHA's `Release` workflow runs. `null` = the LOOKUP failed (`gh` missing,
   *  rate-limited, offline) — categorically NOT "no run exists", exactly like
   *  `readRevision`'s null (#2493). */
  listRuns: (sha: string) => Promise<ReleaseRunRow[] | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Resolve the caller's SHA to its full 40-char form, ONCE, before the poll
   *  loop starts (#2837). `null` = it could not be resolved, and the wait then
   *  polls with the SHA it was given (exactly the pre-#2837 behaviour).
   *  Optional so the existing dep fixtures stay valid. */
  resolveSha?: (sha: string) => string | null;
}

export interface DevPushResult {
  /** True only on a `completed`/`success` run — the one state that proves the
   *  `:dev` tag now points at this SHA. */
  pushed: boolean;
  runId: number | null;
  status: string | null;
  conclusion: string | null;
  /** Successful lookups vs. failed ones — the evidence behind the verdict. */
  polls: number;
  lookupFailures: number;
  detail: string;
}

export const DEV_PUSH_TIMEOUT_SEC = 900;
const DEV_PUSH_POLL_SEC = 15;

/** `Release run 4242` — or an honest stand-in when gh gave no id. */
function runLabel(state: ReleaseRunState | null): string {
  return `Release run ${state?.runId ?? '(unknown id)'}`;
}

/** The verdict text for a run that has finished, either way. */
function completedPushDetail(sha: string, state: ReleaseRunState, polls: number): string {
  return state.conclusion === 'success'
    ? `${runLabel(state)} for ${sha} completed success after ${polls} lookup(s) — :dev is on the registry`
    : `${runLabel(state)} for ${sha} completed ${state.conclusion || '(no conclusion)'} — no :dev image was pushed`;
}

/** The verdict text for a budget that ran out — which `false` it is matters as
 *  much here as it does for `confirmDevImage` (#2493). */
function exhaustedPushDetail(sha: string, state: ReleaseRunState | null, spent: string, polls: number): string {
  if (polls === 0) {
    return `never got an answer from \`gh run list\` for ${sha} within ${spent} — the :dev push state is UNKNOWN, which is NOT evidence the image is missing`;
  }
  if (state === null) return `no Release workflow run for ${sha} within ${spent} — nothing pushed :dev for this SHA`;
  return `${runLabel(state)} for ${sha} still ${state.status || '(no status)'} after ${spent} — the :dev image is not on the registry yet`;
}

/**
 * Wait until the `Release` workflow has pushed `:dev` for `sha`, bounded.
 *
 * This is the fix for the head of the #2820 race: the harness used to flip
 * first, so a run started before the push finished pulled the *previous* `:dev`
 * digest, burned the whole 900s image budget reading the old revision, and
 * reported a false `reachedDev:false` — while the box ran the wrong build for a
 * quarter of an hour.
 *
 * Same verdict discipline as `confirmDevImage`/`confirmFlipBack`: a failed
 * lookup and a missing run are both "not yet", only a *completed* run or budget
 * exhaustion is a verdict, and the deadline is only checked **after** a lookup so
 * there is no blind trailing window. A run that completed non-`success` is
 * terminal immediately — no image is coming, so waiting out the budget would
 * only waste it.
 */
export async function waitForDevPush(
  sha: string,
  deps: DevPushDeps,
  opts: { timeoutSec?: number; pollEverySec?: number } = {},
): Promise<DevPushResult> {
  const requested = opts.timeoutSec ?? DEV_PUSH_TIMEOUT_SEC;
  const timeoutSec = Number.isFinite(requested) && requested > 0 ? requested : DEV_PUSH_TIMEOUT_SEC;
  const pollEverySec = opts.pollEverySec ?? DEV_PUSH_POLL_SEC;

  // `gh run list --commit` matches on the EXACT 40-char SHA and answers a short
  // one with an empty array, not an error — so a short SHA used to poll out the
  // whole budget and report "no Release workflow run" for a run that had already
  // succeeded (#2837). Resolve ONCE here, before the loop, never per poll.
  const lookupSha = deps.resolveSha?.(sha) ?? sha;

  const deadline = deps.now() + timeoutSec * 1000;
  let state: ReleaseRunState | null = null;
  let polls = 0;
  let lookupFailures = 0;

  for (;;) {
    const rows = await deps.listRuns(lookupSha);
    if (rows === null) {
      lookupFailures++;
    } else {
      polls++;
      state = pickReleaseRun(rows);
      if (state?.status === 'completed') {
        const detail = completedPushDetail(sha, state, polls);
        return { pushed: state.conclusion === 'success', ...state, polls, lookupFailures, detail };
      }
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(Math.min(pollEverySec * 1000, deadline - deps.now()));
  }

  const spent = `${timeoutSec}s (${polls} lookup(s), ${lookupFailures} failed lookup(s))`;
  const empty: ReleaseRunState = { runId: null, status: null, conclusion: null };
  return {
    pushed: false,
    ...(state ?? empty),
    polls,
    lookupFailures,
    detail: exhaustedPushDetail(sha, state, spent, polls),
  };
}

/**
 * Is this `set_channel` rejection the CLIENT-side timeout, i.e. the box is still
 * pulling — not a refusal?
 *
 * `set_channel` is awaited server-side through `podman pull …:dev`
 * (`lib/servicebayChannel.ts`, a multi-minute budget) while the harness's MCP
 * call gives up after 30s. Treating that abort as a failed flip made the run
 * flip straight back, so the `:dev` container never started and every fresh SHA
 * needed two attempts (#2820). The POST was accepted; the pull is running. Pure
 * — exported for unit tests.
 */
export function isPullInProgressTimeout(message: string): boolean {
  return /timeout|timed out|operation was aborted|aborterror|timeouterror/i.test(message);
}

/** List the SHA's `Release` runs through `gh`, on the autoloop's own git/gh auth
 *  path (`gitEnv()`, #2761) — no new dependency, `node:` only. `null` = the
 *  lookup itself failed, which the wait treats as "not yet", never as a verdict. */
export async function listReleaseRuns(sha: string): Promise<ReleaseRunRow[] | null> {
  try {
    const out = execFileSync(
      'gh',
      ['run', 'list', '--commit', sha, '--workflow', 'release.yml', '--limit', '20', '--json', 'status,conclusion,databaseId'],
      { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 },
    );
    const rows: unknown = JSON.parse(out);
    return Array.isArray(rows) ? (rows as ReleaseRunRow[]) : null;
  } catch {
    return null; // gh missing / rate-limited / offline — NOT "no run exists"
  }
}

export const DEV_VERIFY_USAGE =
  'usage: autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900] [--flipback-timeout 900] [--push-timeout 900] [--assume-pushed]\n' +
  '       autoloop-dev-verify.ts --recover      # flip an orphaned :dev flip back to :latest (#2826)';

export interface DevVerifyArgs {
  sha: string;
  probeScript: string;
  imageTimeout: number;
  flipBackTimeout: number;
  /** Budget for the pre-flip wait on the SHA's `Release` run (#2820). */
  pushTimeout: number;
  /** Skip that wait entirely — for a re-run of a SHA already on the registry. */
  assumePushed: boolean;
}

/** A positive number of seconds, or the loud reason it is not one. A missing or
 *  garbage value used to reach the wait loops as `NaN` and collapse them to zero
 *  iterations (#2493). */
function parseSeconds(flag: string, value: string | undefined): { seconds: number } | { error: string } {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n) || n <= 0) {
    return { error: `${flag} needs a positive number of seconds (got ${value ?? '<nothing>'})` };
  }
  return { seconds: n };
}

/** The SHA positional is compared against the image's OCI revision label, which
 *  is hex — anything else can never match, so it is rejected up front rather
 *  than after a 900s wait. Returns the reason, or null when it is fine. */
function shaError(sha: string | undefined): string | null {
  if (!sha) return 'missing <sha>';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? null : `<sha> must be a 7-40 char git SHA (got ${sha})`;
}

/**
 * Strict CLI parse — a mis-parsed argument used to become a silent
 * `reachedDev:false` (#2493), so every shape that can't be honoured is a loud
 * setup error instead:
 *  - the old `argv.find(a => !a.startsWith('--'))` picked the first positional
 *    *anywhere*, so `--probe-script /tmp/p.sh <sha>` bound the script path as the
 *    SHA — non-hex, so no revision could ever match and the run burned the whole
 *    image budget before reporting a false negative.
 *  - `Number(argv[i + 1])` on a missing/garbage value yielded `NaN`, and a `NaN`
 *    deadline made the wait loop exit *immediately* with `false`.
 * Accepts both `--opt value` and `--opt=value`. Pure — exported for unit tests.
 */
export function parseDevVerifyArgs(argv: string[]): { args: DevVerifyArgs } | { error: string } {
  let sha: string | undefined;
  let probeScript: string | undefined;
  let assumePushed = false;
  // prettier-ignore
  const numeric: Record<string, number> =
    { '--image-timeout': DEV_IMAGE_TIMEOUT_SEC, '--flipback-timeout': FLIP_BACK_TIMEOUT_SEC, '--push-timeout': DEV_PUSH_TIMEOUT_SEC };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    if (!raw.startsWith('--')) {
      if (sha !== undefined) return { error: `unexpected extra argument: ${raw}` };
      sha = raw;
      continue;
    }
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      return next === undefined || next.startsWith('--') ? undefined : next;
    };
    if (flag === '--probe-script') {
      const value = takeValue();
      if (!value) return { error: 'missing value for --probe-script' };
      probeScript = value;
    } else if (flag === '--assume-pushed') {
      // A boolean flag: a value would silently be read as the SHA positional.
      if (inlineValue !== undefined) return { error: '--assume-pushed takes no value' };
      assumePushed = true;
    } else if (flag in numeric) {
      const seconds = parseSeconds(flag, takeValue());
      if ('error' in seconds) return seconds;
      numeric[flag] = seconds.seconds;
    } else {
      return { error: `unknown option: ${flag}` };
    }
  }

  const badSha = shaError(sha);
  if (badSha) return { error: badSha };
  if (!probeScript) return { error: 'missing --probe-script <path>' };

  return {
    args: {
      sha: sha as string,
      probeScript,
      imageTimeout: numeric['--image-timeout'] as number,
      flipBackTimeout: numeric['--flipback-timeout'] as number,
      pushTimeout: numeric['--push-timeout'] as number,
      assumePushed,
    },
  };
}

// ---------- the run, with a named reason on every abort (#2622) ----------

/** Where a run can abort. The step is the *named reason* half of the #2622 fix:
 *  a failure that says `flip-to-dev` is a different bug report than one that says
 *  `probe-script`, and neither can be confused with "the :dev image never
 *  landed" (which is `failure:null` + a `devImage` verdict). */
export type DevVerifyStep =
  | 'preflight-health'
  // The SHA's `:dev` image never made it onto the registry (#2820) — the run
  // stopped BEFORE any flip, so this can never be confused with `flip-to-dev`
  // (the flip POST itself being refused), and the box was never touched.
  | 'dev-image-not-pushed'
  | 'flip-to-dev'
  | 'health-after-flip'
  | 'confirm-dev-image'
  | 'health-on-dev'
  | 'probe-script'
  | 'flip-back';

export interface DevVerifyFailure {
  step: DevVerifyStep;
  message: string;
}

/** A thrown value rendered as a one-line reason. An `Error` with an empty
 *  message (some `fetch`/abort rejections) still has to name *something* —
 *  returning `''` here would put the blind failure straight back. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message.trim() || e.name || 'Error (no message)';
  if (typeof e === 'string' && e.trim()) return e.trim();
  try {
    const s = JSON.stringify(e);
    if (s && s !== '{}' && s !== 'null') return s;
  } catch {
    /* fall through to the generic shape below */
  }
  return `non-Error thrown: ${Object.prototype.toString.call(e)}`;
}

/** Box I/O the run needs, injected so every abort path is unit-testable without
 *  a real box (the flip-back guarantee included). */
export interface DevVerifyRunDeps {
  /** Wait for the SHA's `:dev` image to be pushed, BEFORE anything is flipped. */
  waitForDevPush: (sha: string, timeoutSec: number) => Promise<DevPushResult>;
  setChannel: (target: 'dev') => Promise<void>;
  waitHealth: (timeoutSec: number) => Promise<boolean>;
  confirmDevImage: (sha: string, timeoutSec: number) => Promise<DevImageResult>;
  runProbe: () => Promise<{ exit: number; output: string }>;
  flipBack: (timeoutSec: number) => Promise<FlipBackResult>;
  /** Record "a flip to `:dev` is in flight" on a path that outlives this
   *  container, BEFORE the flip POST (#2826). A throw here aborts the run at
   *  `flip-to-dev` with the box untouched — fail closed: no marker means no
   *  recovery if the container is recreated mid-flip. Optional so the many
   *  existing dep fixtures stay valid. */
  markFlipped?: (sha: string) => void;
  /** Drop that marker — only ever after a CONFIRMED flip-back. */
  clearMark?: () => void;
}

export interface DevVerifyOutcome {
  reachedDev: boolean;
  /** The pre-flip registry verdict (#2820); `null` only if the run never got
   *  that far (it is the first step). */
  devPush: DevPushResult | null;
  devImage: DevImageResult | null;
  /** The `set_channel dev` client-timeout message, when the POST was accepted
   *  but the server was still pulling — evidence, not a failure (#2820). */
  flipTimeout: string | null;
  probeExit: number;
  probeOutput: string;
  /** `null` on a clean run *and* on a clean "image never landed" verdict; a
   *  named `{step,message}` whenever the run aborted instead. */
  failure: DevVerifyFailure | null;
  flipBack: FlipBackResult;
}

const HEALTH_WAIT_SEC = 180;

/** The mutable half of a run — what has been established so far, and the step
 *  the run is currently in (which names a `failure` if it aborts there). */
interface RunProgress {
  step: DevVerifyStep;
  reachedDev: boolean;
  devPush: DevPushResult | null;
  devImage: DevImageResult | null;
  flipTimeout: string | null;
  probeExit: number;
  probeOutput: string;
}

/** The flip-back "result" of a run that never flipped, so `flippedBack:false`
 *  keeps meaning "the box may be stranded" and nothing else (#2820). */
const NEVER_FLIPPED: FlipBackResult = {
  flippedBack: true,
  channel: null,
  reissues: 0,
  polls: 0,
  detail: 'no flip-back needed — the run never flipped to :dev (the :dev image was never pushed)',
};

/**
 * Flip to `:dev`, confirm the image, run the probes, **always flip back**.
 *
 * Never throws and never calls `process.exit` — both were how the reason got
 * lost. The old shape had a bare `try { … } finally { … process.exit(…) }`: an
 * exception from `setChannel('dev')` (a refused/timed-out `/mcp` POST against a
 * box still restarting from a previous run — the live 2026-08-25 08:03 case) hit
 * the `finally`, which flipped back correctly and then `process.exit`ed, and a
 * `process.exit` inside a `finally` **discards the pending exception**: the
 * top-level `.catch` never ran, nothing reached stderr, and the emitted line
 * carried `devImage:null` with an empty `probeOutput`. Now the same throw is
 * caught and recorded as `failure:{step:'flip-to-dev',…}`.
 *
 * The flip-back stays in the `finally` — that is the load-bearing invariant
 * ("never leave the box stranded on `:dev`"), and it is structural, not a rule
 * the catch happens to honour. A throw from the flip-back itself is turned into
 * `flippedBack:false` (exit 5, hard alert) rather than escaping unreported.
 */
export async function runDevVerify(
  sha: string,
  deps: DevVerifyRunDeps,
  opts: { imageTimeout: number; flipBackTimeout: number; pushTimeout: number },
): Promise<DevVerifyOutcome> {
  // prettier-ignore
  const run: RunProgress =
    { step: 'dev-image-not-pushed', reachedDev: false, devPush: null, devImage: null, flipTimeout: null, probeExit: -1, probeOutput: '' };
  let failure: DevVerifyFailure | null = null;
  let flipBack: FlipBackResult;

  try {
    // FIRST, before touching the box: is this SHA's :dev image on the registry?
    // Flipping ahead of the push pulls the PREVIOUS digest and verifies the
    // wrong build (#2820).
    run.devPush = await deps.waitForDevPush(sha, opts.pushTimeout);
    if (run.devPush.pushed) {
      await flipAndProbe(sha, deps, opts, run);
    } else {
      failure = { step: run.step, message: run.devPush.detail };
      run.probeOutput = `run failed at step ${run.step}: ${run.devPush.detail}`;
    }
  } catch (e) {
    failure = { step: run.step, message: describeError(e) };
    run.probeOutput = run.probeOutput || `run failed at step ${run.step}: ${failure.message}`;
  } finally {
    // STRUCTURAL INVARIANT: always flip back to :latest, whatever happened above.
    // Confirmation tolerates the full restart window (#2387) — a null/stale
    // read is "not yet", only budget exhaustion is a verdict.
    //
    // The ONE exception is a run that PROVABLY never flipped: the `:dev` image
    // was never pushed, so `setChannel` was never called and the box was never
    // touched. `set_channel` recreates + restarts the container even for the
    // channel it is already on (`lib/servicebayChannel.ts`), so a "flip back"
    // there is a pointless restart, not a safety net — the same reasoning as the
    // preflight-health abort in `main`.
    if (failure?.step === 'dev-image-not-pushed') {
      flipBack = NEVER_FLIPPED;
    } else {
      try {
        flipBack = await deps.flipBack(opts.flipBackTimeout);
      } catch (e) {
        const message = describeError(e);
        // prettier-ignore
        flipBack = { flippedBack: false, channel: null, reissues: 0, polls: 0, detail: `flip-back itself threw (${message}) — the box may be stranded on :dev` };
        failure = failure ?? { step: 'flip-back', message };
      }
    }
    // The marker outlives this process on purpose, so it is dropped ONLY on a
    // confirmed flip-back. A `flippedBack:false` leaves it standing — that is
    // exactly the state `--recover` is there to repair (#2826). Clearing it must
    // never turn a completed run into a throw.
    if (flipBack.flippedBack) {
      try {
        deps.clearMark?.();
      } catch {
        /* the marker is a safety net, not a verdict — a failed unlink at worst
           costs one redundant flip-back on the next recovery pass */
      }
    }
  }

  const { reachedDev, devPush, devImage, flipTimeout, probeExit, probeOutput } = run;
  return { reachedDev, devPush, devImage, flipTimeout, probeExit, probeOutput, failure, flipBack };
}

/**
 * The half of the run that touches the box: flip, confirm the image, probe.
 *
 * Split out of `runDevVerify` so the flip-back `finally` stays readable at a
 * glance; it records into `run` as it goes, so an abort at any step still
 * carries the evidence gathered before it (the confirmed image, say) and the
 * step it died at. It deliberately does NOT catch — a throw is the caller's
 * `failure:{step,message}`, named by `run.step`.
 */
async function flipAndProbe(
  sha: string,
  deps: DevVerifyRunDeps,
  opts: { imageTimeout: number },
  run: RunProgress,
): Promise<void> {
  run.step = 'flip-to-dev';
  // BEFORE the POST: a marker written after it would miss the window where the
  // flip landed but this process died (#2826).
  deps.markFlipped?.(sha);
  try {
    await deps.setChannel('dev');
  } catch (e) {
    // A CLIENT-side timeout is not a refused flip: the box awaits the `podman
    // pull` server-side for minutes while this call gives up after 30s. The POST
    // landed; the pull is running — so keep going and let the image budget below
    // decide, instead of flipping straight back (#2820).
    const message = describeError(e);
    if (!isPullInProgressTimeout(message)) throw e;
    run.flipTimeout = message;
  }
  // Not a settle window: the OUTGOING container keeps answering /api/health
  // right through the flip (#2387), so the revision poll below — not this
  // wait — is the authority on whether the :dev image is actually live.
  run.step = 'health-after-flip';
  await deps.waitHealth(HEALTH_WAIT_SEC);
  run.step = 'confirm-dev-image';
  const devImage = await deps.confirmDevImage(sha, opts.imageTimeout);
  run.devImage = devImage;
  const reachedDev = devImage.reached;
  run.reachedDev = reachedDev;
  if (!reachedDev) {
    run.probeOutput = `did not confirm :dev image with revision ${sha}: ${devImage.detail}`;
    return;
  }
  run.step = 'health-on-dev';
  await deps.waitHealth(HEALTH_WAIT_SEC);
  // Run the agent-supplied probes against the box on :dev.
  run.step = 'probe-script';
  const probe = await deps.runProbe();
  run.probeExit = probe.exit;
  run.probeOutput = probe.output;
}

/**
 * The emitted result object — and the last line of defence for #2622.
 *
 * A run that did not reach `:dev` must carry a reason: either a `devImage`
 * verdict ("still in flight" / "the box never answered") or a named `failure`.
 * If a future edit ever produces neither, this synthesises a failure rather than
 * emitting the blind `devImage:null` shape again.
 */
export function devVerifyResultLine(o: DevVerifyOutcome): Record<string, unknown> {
  let failure = o.failure;
  let probeOutput = o.probeOutput;
  if (!o.reachedDev && o.devImage === null && failure === null) {
    failure = {
      step: 'confirm-dev-image',
      message:
        'aborted before image confirmation with no reason recorded — harness bug (#2622); treat as UNVERIFIED, not as "image missing"',
    };
    probeOutput = probeOutput || `run failed at step ${failure.step}: ${failure.message}`;
  }
  return {
    reachedDev: o.reachedDev,
    probeExit: o.probeExit,
    flippedBack: o.flipBack.flippedBack,
    // The CONFIGURED channel (get_channel), NOT proof of the running image —
    // it reported `latest` on a box running :dev on 2026-08-25. `reachedDev`
    // above is the image-level answer (podman inspect revision label).
    channel: o.flipBack.channel,
    // Evidence behind reachedDev, so a `false` is diagnosable from the result
    // line alone — reads:0 means "the box never answered", not "no :dev image"
    // (#2493). No manual list_containers cross-check needed either way.
    devImage: o.devImage
      ? {
          revision: o.devImage.revision,
          reads: o.devImage.reads,
          readFailures: o.devImage.readFailures,
          detail: o.devImage.detail,
        }
      : null,
    // Why the run was allowed to flip at all (#2820): the SHA's Release run had
    // pushed `:dev`. A `pushed:false` here is the `dev-image-not-pushed` failure
    // — the box was never touched, so this is "come back later", not red.
    devPush: o.devPush
      ? {
          pushed: o.devPush.pushed,
          runId: o.devPush.runId,
          status: o.devPush.status,
          conclusion: o.devPush.conclusion,
          polls: o.devPush.polls,
          lookupFailures: o.devPush.lookupFailures,
          detail: o.devPush.detail,
        }
      : null,
    // Non-null ⇒ the flip POST timed out CLIENT-side while the box kept pulling;
    // the run carried on and the image budget decided. Not a failure (#2820).
    flipTimeout: o.flipTimeout,
    // The named abort reason (#2622). null ⇒ the run completed its own steps.
    failure,
    flipBack: { reissues: o.flipBack.reissues, polls: o.flipBack.polls, detail: o.flipBack.detail },
    probeOutput: probeOutput.slice(0, 4000),
  };
}

/** Exit code from the outcome: 5 = flip-back failed (box may be stranded — hard
 *  alert), 2 = harness failure or never reached `:dev`, 0 = ran and flipped back
 *  (probeExit/probeOutput are the LLM's to judge). */
export function devVerifyExitCode(o: DevVerifyOutcome): number {
  if (!o.flipBack.flippedBack) return 5;
  if (o.failure !== null || !o.reachedDev) return 2;
  return 0;
}

// ---------- the in-flight marker + recovery (#2826) ----------

/** Hard cap on the probe script, shared with the marker's expiry budget. */
const PROBE_TIMEOUT_SEC = 15 * 60;
/** Slack on top of the run's own budgets before a marker counts as abandoned. */
const MARKER_GRACE_SEC = 300;

/**
 * Where the "a flip to `:dev` is in flight" marker lives.
 *
 * `.claude/state/` is gitignored (the existing `/.claude/*` rule) and lives in
 * the **repo checkout**, which for the agent running this harness is a
 * persistent volume — so the file survives the `claude-dev` container being
 * recreated, which is precisely what kills the harness (#2826). The marker is
 * the harness's own file: nothing else reads or writes it, and it is NOT the
 * broker cache (`autoloop-cache.json`) or box-verify's result file.
 */
export const DEV_VERIFY_MARKER_PATH = '.claude/state/dev-verify-inflight.json';

/** What a run records about the flip it is in the middle of. */
export interface DevVerifyMarker {
  /** the SHA being verified — carried so a recovery can say what it repaired */
  sha: string;
  /** the channel the box was flipped TO (always `dev` today) */
  channel: 'dev';
  flippedAt: string;
  /** the flip time plus the run's own budgets: past this, the run cannot still
   *  be honestly in flight even if a pid happens to match. */
  expiresAt: string;
  /** the harness process, so a later pass can ask "is that run still alive?" */
  pid: number;
  /** the argv fingerprint that pid must still carry — a bare pid is reused, and
   *  a recreated container starts its pid numbering over. */
  cmdlineMatch: string;
}

/** The total wall clock a run can legitimately hold the box on `:dev`. */
export function markerBudgetSec(opts: { imageTimeout: number; flipBackTimeout: number }): number {
  return opts.imageTimeout + opts.flipBackTimeout + PROBE_TIMEOUT_SEC + 2 * HEALTH_WAIT_SEC + MARKER_GRACE_SEC;
}

/** The marker for a run flipping `sha` now. Pure — the caller writes it. */
export function buildDevVerifyMarker(
  sha: string,
  opts: { imageTimeout: number; flipBackTimeout: number },
  ctx: { now: number; pid: number },
): DevVerifyMarker {
  return {
    sha,
    channel: 'dev',
    flippedAt: new Date(ctx.now).toISOString(),
    expiresAt: new Date(ctx.now + markerBudgetSec(opts) * 1000).toISOString(),
    pid: ctx.pid,
    cmdlineMatch: 'autoloop-dev-verify',
  };
}

/** `null` = no marker (or an unreadable/corrupt one, which is the same thing:
 *  nothing can be proven in flight from it). */
export function readDevVerifyMarker(path = DEV_VERIFY_MARKER_PATH, cwd = process.cwd()): DevVerifyMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as DevVerifyMarker;
    return typeof parsed?.sha === 'string' && typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDevVerifyMarker(marker: DevVerifyMarker, path = DEV_VERIFY_MARKER_PATH, cwd = process.cwd()): void {
  const file = resolve(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`);
}

export function clearDevVerifyMarker(path = DEV_VERIFY_MARKER_PATH, cwd = process.cwd()): void {
  rmSync(resolve(cwd, path), { force: true });
}

/** `/proc/<pid>/cmdline` with the NUL separators flattened, or null if the pid
 *  is gone (the container-recreated case, and the ordinary exited case). */
export function readProcCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
}

/**
 * Is the process that took the flip still running?
 *
 * The cmdline check is load-bearing, not belt-and-braces: after the container is
 * recreated, pid numbering starts over, so the recorded pid is very likely to be
 * *some* live process in the new container — matching on the pid alone would
 * report a dead harness as in flight and skip the repair.
 */
export function isHarnessProcessAlive(marker: DevVerifyMarker, readCmdline: (pid: number) => string | null): boolean {
  const cmdline = readCmdline(marker.pid);
  return cmdline !== null && cmdline.includes(marker.cmdlineMatch);
}

export type ChannelRecoveryAction = 'repair' | 'harness-in-flight' | 'not-on-dev' | 'channel-unknown';

export interface ChannelRecoveryInputs {
  /** MCP `get_channel`; `null` = the box did not answer. */
  channel: string | null;
  marker: DevVerifyMarker | null;
  harnessAlive: boolean;
  now: number;
}

export interface ChannelRecoveryDecision {
  action: ChannelRecoveryAction;
  reason: string;
  /** the marker is dead weight and should be dropped whatever else happens */
  staleMarker: boolean;
}

/**
 * Should this pass flip the box back to `:latest`?
 *
 * The whole class of #2826 in one pure function: **a box on `:dev` that no live
 * harness owns is stranded**, whether the owner exited, its session died, or its
 * container was recreated out from under it. A `null` channel is never a verdict
 * (the box may just be mid-restart) — the recovery must not flip blind.
 */
export function decideChannelRecovery(input: ChannelRecoveryInputs): ChannelRecoveryDecision {
  const { channel, marker, harnessAlive, now } = input;
  if (channel === null) {
    return { action: 'channel-unknown', reason: 'the box did not answer get_channel — no flip attempted', staleMarker: false };
  }
  if (channel !== 'dev') {
    return {
      action: 'not-on-dev',
      reason: `the box reports channel ${channel} — nothing to repair`,
      // A marker left behind by a run that did flip back (or never flipped) is
      // just litter once the box is off :dev.
      staleMarker: marker !== null,
    };
  }
  if (!marker) {
    return {
      action: 'repair',
      reason: 'the box is on :dev with no in-flight marker — no run owns this flip',
      staleMarker: false,
    };
  }
  const expiry = Date.parse(marker.expiresAt);
  if (!Number.isFinite(expiry) || now > expiry) {
    return {
      action: 'repair',
      reason: `the in-flight marker for ${marker.sha} is past its budget (expiresAt ${marker.expiresAt}) — the run cannot still be flipping`,
      staleMarker: true,
    };
  }
  if (!harnessAlive) {
    return {
      action: 'repair',
      reason: `the harness that flipped ${marker.sha} (pid ${marker.pid}) is gone — its process tree died, most likely with its container`,
      staleMarker: true,
    };
  }
  return {
    action: 'harness-in-flight',
    reason: `pid ${marker.pid} is still verifying ${marker.sha} until ${marker.expiresAt} — leave the box on :dev`,
    staleMarker: false,
  };
}

export interface ChannelRecoveryDeps {
  getChannel: () => Promise<string | null>;
  setChannel: (target: 'latest') => Promise<void>;
  readMarker: () => DevVerifyMarker | null;
  clearMarker: () => void;
  isAlive: (marker: DevVerifyMarker) => boolean;
  now: () => number;
}

export interface ChannelRecoveryResult extends ChannelRecoveryDecision {
  channel: string | null;
  repaired: boolean;
  /** why the repair flip itself failed, when it did */
  error: string | null;
  markerSha: string | null;
}

/** Read the channel + marker, decide, and flip back when the flip is orphaned. */
export async function recoverStrandedChannel(deps: ChannelRecoveryDeps): Promise<ChannelRecoveryResult> {
  const channel = await deps.getChannel();
  const marker = deps.readMarker();
  const decision = decideChannelRecovery({
    channel,
    marker,
    harnessAlive: marker ? deps.isAlive(marker) : false,
    now: deps.now(),
  });

  let repaired = false;
  let error: string | null = null;
  if (decision.action === 'repair') {
    try {
      await deps.setChannel('latest');
      repaired = true;
    } catch (e) {
      error = describeError(e);
    }
  }
  // Drop the marker once the flip-back landed, or when it was pure litter on a
  // box that is not on `:dev` at all. A FAILED repair keeps it: the box is still
  // stranded, and the marker is the only record of which run left it there.
  if (repaired || (decision.action !== 'repair' && decision.staleMarker)) {
    try {
      deps.clearMarker();
    } catch {
      /* litter, not a verdict */
    }
  }
  return { ...decision, channel, repaired, error, markerSha: marker?.sha ?? null };
}

/** 5 = the box is on `:dev` and the repair flip FAILED (same hard-alert code as
 *  a failed flip-back), 2 = the channel could not be read, 0 = the box is known
 *  not to be stranded (repaired, off `:dev`, or legitimately in flight). */
export function recoverExitCode(r: ChannelRecoveryResult): number {
  if (r.action === 'repair') return r.repaired ? 0 : 5;
  return r.action === 'channel-unknown' ? 2 : 0;
}

/** `--recover`: the preflight repair pass (#2826). Reads `get_channel` + the
 *  in-flight marker and flips an orphaned `:dev` back to `:latest`. */
async function recoverMain(argv: string[]): Promise<void> {
  const extra = argv.filter(a => a !== '--recover');
  if (extra.length > 0) {
    console.error(`--recover takes no other arguments (got ${extra.join(' ')})\n${DEV_VERIFY_USAGE}`);
    process.exit(2);
  }
  const result = await recoverStrandedChannel({
    getChannel,
    setChannel: target => setChannel(target),
    readMarker: () => readDevVerifyMarker(),
    clearMarker: () => clearDevVerifyMarker(),
    isAlive: marker => isHarnessProcessAlive(marker, readProcCmdline),
    now: () => Date.now(),
  });
  console.log(`AUTOLOOP_DEV_VERIFY_RECOVER ${JSON.stringify(result)}`);
  process.exit(recoverExitCode(result));
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--recover')) {
    await recoverMain(process.argv.slice(2));
    return;
  }
  const parsed = parseDevVerifyArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${DEV_VERIFY_USAGE}`);
    process.exit(2);
  }
  const { sha, probeScript, imageTimeout, flipBackTimeout, pushTimeout, assumePushed } = parsed.args;

  const emit = (o: Record<string, unknown>) => console.log(`AUTOLOOP_DEV_VERIFY_RESULT ${JSON.stringify(o)}`);

  // Confirm the box is up before touching the channel. Nothing has been flipped
  // yet, so there is nothing to flip back — but the reason is still named.
  if (!(await waitHealth(120))) {
    emit(
      devVerifyResultLine({
        reachedDev: false,
        devPush: null,
        devImage: null,
        flipTimeout: null,
        probeExit: -1,
        probeOutput: 'box not reachable before flip',
        failure: {
          step: 'preflight-health',
          message: 'box did not answer /api/health within 120s — no channel flip was attempted',
        },
        flipBack: {
          flippedBack: false,
          channel: null,
          reissues: 0,
          polls: 0,
          detail: 'no flip-back needed — the run never flipped to :dev',
        },
      }),
    );
    process.exit(2);
  }

  const outcome = await runDevVerify(
    sha,
    {
      waitForDevPush: async (s, timeoutSec) => {
        const result = assumePushed
          ? {
              pushed: true,
              runId: null,
              status: null,
              conclusion: null,
              polls: 0,
              lookupFailures: 0,
              detail: '--assume-pushed: skipped the Release-run wait',
            }
          : await waitForDevPush(
              s,
              {
                listRuns: listReleaseRuns,
                sleep: ms => new Promise(r => setTimeout(r, ms)),
                now: () => Date.now(),
                resolveSha: rev => resolveFullSha(rev),
              },
              { timeoutSec },
            );
        // Pre-pull :dev so the flip is a cache-hit (survives the exec caps —
        // memory feedback_box_update_slow_pull_timeout). AFTER the push check,
        // never before: pre-pulling ahead of the push caches the PREVIOUS digest
        // (#2820).
        if (result.pushed) {
          await mcpExec(
            'systemd-run --user --unit=sb-prepull-dev --quiet podman pull ghcr.io/mdopp/servicebay:dev || true',
          ).catch(() => {});
        }
        return result;
      },
      setChannel: target => setChannel(target),
      waitHealth: timeoutSec => waitHealth(timeoutSec),
      confirmDevImage: (s, timeoutSec) =>
        confirmDevImage(
          s,
          { readRevision: runningRevision, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now() },
          { timeoutSec },
        ),
      runProbe: async () => {
        try {
          return {
            exit: 0,
            output: execFileSync('bash', [probeScript], { encoding: 'utf8', timeout: PROBE_TIMEOUT_SEC * 1000 }),
          };
        } catch (e) {
          // A probe that exits non-zero is a RED verdict, not a harness failure —
          // it is captured here rather than thrown, so `failure` stays reserved
          // for the harness's own aborts.
          const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
          return {
            exit: typeof err.status === 'number' ? err.status : 1,
            output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`,
          };
        }
      },
      // The flip-back that outlives this container (#2826): written before the
      // flip POST, dropped only once `confirmFlipBack` succeeded.
      markFlipped: s =>
        writeDevVerifyMarker(
          buildDevVerifyMarker(s, { imageTimeout, flipBackTimeout }, { now: Date.now(), pid: process.pid }),
        ),
      clearMark: () => clearDevVerifyMarker(),
      flipBack: timeoutSec =>
        confirmFlipBack(
          {
            setChannel: target => setChannel(target),
            waitHealth: sec => waitHealth(sec),
            getChannel,
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            now: () => Date.now(),
          },
          { timeoutSec },
        ),
    },
    { imageTimeout, flipBackTimeout, pushTimeout },
  );

  emit(devVerifyResultLine(outcome));
  process.exit(devVerifyExitCode(outcome));
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('autoloop-dev-verify.ts') || invoked.endsWith('autoloop-dev-verify.js')) {
  main().catch(e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
