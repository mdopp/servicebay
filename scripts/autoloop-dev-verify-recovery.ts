/**
 * The state that outlives the harness process, and the `--recover` repair pass
 * (#2826). Extracted out of `scripts/autoloop-dev-verify.ts` (#2926), which sat
 * at exactly 800/800 code lines so the next change to the verify harness could
 * not be made without first raising the cap.
 *
 * The block is a coherent slice, not an arbitrary cut: everything here answers
 * one question — **"is a box on `:dev` still owned by a live run, or is it
 * stranded?"** — and it answers it from state on disk plus one `get_channel`
 * read, with no knowledge of a run in progress.
 *
 * The dependency edge is ONE-WAY: `autoloop-dev-verify.ts` imports this module
 * and re-exports its names (so every existing call site and test keeps working);
 * this module must never import the harness back. That is why the two budget
 * constants (`PROBE_TIMEOUT_SEC`, `HEALTH_WAIT_SEC`) and `describeError` live
 * here — the marker's expiry budget is computed from them, and `markerBudgetSec`
 * takes only `{imageTimeout, flipBackTimeout}`, so they cannot be passed in.
 *
 * Why the marker exists at all: the orchestrator and the harness run *inside*
 * the `claude-dev` container on the box, so a verify whose probes restart that
 * service kill the harness's whole process tree — no `finally`, no flip-back,
 * box left on `:dev`. The marker is written before the flip POST and dropped
 * only on a CONFIRMED flip-back, so a later pass can tell a live run from a
 * dead one.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getChannel, setChannel, describeBoxCandidates } from './autoloop-box';

/** Hard cap on the probe script, shared with the marker's expiry budget. */
export const PROBE_TIMEOUT_SEC = 15 * 60;
/** The health wait the run spends after each flip, twice per run. */
export const HEALTH_WAIT_SEC = 180;
/** Slack on top of the run's own budgets before a marker counts as abandoned. */
const MARKER_GRACE_SEC = 300;

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
  /** The box origins the resolution would try, safe to print. Named in the
   *  `channel-unknown` reason so "I could not ask the box" says *where* it
   *  asked instead of being an unactionable shrug (#2922). */
  triedCandidates?: string[];
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
  const { channel, marker, harnessAlive, now, triedCandidates } = input;
  if (channel === null) {
    const where = triedCandidates?.length ? ` (tried ${triedCandidates.join(', ')})` : '';
    return { action: 'channel-unknown', reason: `the box did not answer get_channel — no flip attempted${where}`, staleMarker: false };
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
  /** the ordered, printable box origins the resolution would try (#2922) */
  boxCandidates?: () => string[];
}

export interface ChannelRecoveryResult extends ChannelRecoveryDecision {
  channel: string | null;
  repaired: boolean;
  /** why the repair flip itself failed, when it did */
  error: string | null;
  markerSha: string | null;
  /** The box origins the read would have tried, as a MACHINE-READABLE field and
   *  not only inside `reason` (#2926). It was dropped from the emitted JSON to
   *  stay under the max-lines cap, which is exactly the trade the extraction
   *  above bought back: a caller deciding what to do about a `channel-unknown`
   *  should not have to regex a human sentence to learn where the harness
   *  looked. Optional in the TYPE so a hand-built result in a test stays valid;
   *  `recoverStrandedChannel` always sets it. */
  triedCandidates?: string[];
}

/** Read the channel + marker, decide, and flip back when the flip is orphaned. */
export async function recoverStrandedChannel(deps: ChannelRecoveryDeps): Promise<ChannelRecoveryResult> {
  const channel = await deps.getChannel();
  const marker = deps.readMarker();
  const triedCandidates = (deps.boxCandidates ?? describeBoxCandidates)();
  const decision = decideChannelRecovery({
    channel,
    marker,
    harnessAlive: marker ? deps.isAlive(marker) : false,
    now: deps.now(),
    triedCandidates,
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
  return { ...decision, channel, repaired, error, markerSha: marker?.sha ?? null, triedCandidates };
}

/** 5 = the box is on `:dev` and the repair flip FAILED (same hard-alert code as
 *  a failed flip-back), 2 = the channel could not be read, 0 = the box is known
 *  not to be stranded (repaired, off `:dev`, or legitimately in flight). */
export function recoverExitCode(r: ChannelRecoveryResult): number {
  if (r.action === 'repair') return r.repaired ? 0 : 5;
  return r.action === 'channel-unknown' ? 2 : 0;
}

/** `--recover`: the preflight repair pass (#2826). Reads `get_channel` + the
 *  in-flight marker and flips an orphaned `:dev` back to `:latest`. `usage` is
 *  passed in rather than imported, so this module never depends back on the
 *  harness that re-exports it. */
export async function recoverMain(argv: string[], usage: string): Promise<void> {
  const extra = argv.filter(a => a !== '--recover');
  if (extra.length > 0) {
    console.error(`--recover takes no other arguments (got ${extra.join(' ')})\n${usage}`);
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
