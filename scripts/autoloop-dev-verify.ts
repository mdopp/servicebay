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
 *   tsx scripts/autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900] [--flipback-timeout 900]
 *
 * The probe script runs while the box is on `:dev @ <sha>`; its stdout/stderr +
 * exit code are captured and returned. Emits one machine-readable last line:
 *   AUTOLOOP_DEV_VERIFY_RESULT {"reachedDev":true,"probeExit":0,"flippedBack":true,"channel":"latest",
 *                               "devImage":{"revision":"…","reads":3,"readFailures":1,"detail":"…"},"probeOutput":"…"}
 *
 * `reachedDev` and `flippedBack` are trustworthy on their own — both poll
 * through the whole restart window and carry their evidence (`devImage`,
 * `flipBack`), so no manual `list_containers`/image-tag cross-check is needed
 * (#2387, #2493).
 *
 * Exit 0 = harness ran and flipped back (READ probeExit/probeOutput to judge
 * green/red — that's the LLM's job); exit 2 = harness setup failure (never
 * reached :dev) but ALWAYS attempted flip-back; exit 5 = flip-back FAILED (box
 * may be stranded on :dev — hard alert, orchestrator recovers).
 */

import { execFileSync } from 'node:child_process';
import { getChannel, setChannel, waitHealth, mcpExec } from './autoloop-box';

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

/** The last non-empty line of a `podman inspect --format` stdout, with Go
 *  template's `<no value>` (label absent from the image) normalised to `''`.
 *  Exported for unit tests. */
export function parseRevisionOutput(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last === '<no value>' ? '' : last;
}

/**
 * The OCI revision label (full git SHA) of the running `servicebay` container.
 *
 * `null` means **the read itself failed** — `/mcp` is served by the very app the
 * channel flip restarts, so a refused connection / non-zero `podman inspect`
 * (container momentarily absent) is expected mid-flip. That is categorically
 * different from a *successful* read returning a revision that isn't the target
 * yet, and the two must not collapse into one value: collapsing them is what
 * made a `reachedDev:false` verdict unreadable (#2493).
 *
 * This is the SHA baked into the image, NOT the tag (`{{.Config.Image}}`
 * returns the tag name, which never carries a SHA).
 */
async function runningRevision(): Promise<string | null> {
  try {
    const { code, stdout } = await mcpExec(
      'podman inspect --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\' servicebay',
    );
    if (code !== 0) return null; // no such container / podman busy → mid-restart
    return parseRevisionOutput(stdout);
  } catch {
    return null; // /mcp unreachable (it lives in the app being restarted)
  }
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

export const DEV_VERIFY_USAGE =
  'usage: autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900] [--flipback-timeout 900]';

export interface DevVerifyArgs {
  sha: string;
  probeScript: string;
  imageTimeout: number;
  flipBackTimeout: number;
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
  const numeric: Record<string, number> = { '--image-timeout': DEV_IMAGE_TIMEOUT_SEC, '--flipback-timeout': FLIP_BACK_TIMEOUT_SEC };

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
    } else if (flag in numeric) {
      const value = takeValue();
      const n = Number(value);
      if (value === undefined || !Number.isFinite(n) || n <= 0) {
        return { error: `${flag} needs a positive number of seconds (got ${value ?? '<nothing>'})` };
      }
      numeric[flag] = n;
    } else {
      return { error: `unknown option: ${flag}` };
    }
  }

  if (!sha) return { error: 'missing <sha>' };
  // The SHA is compared against the image's OCI revision label, which is hex —
  // anything else can never match, so reject it here rather than after 900s.
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { error: `<sha> must be a 7-40 char git SHA (got ${sha})` };
  if (!probeScript) return { error: 'missing --probe-script <path>' };

  return {
    args: {
      sha,
      probeScript,
      imageTimeout: numeric['--image-timeout'] as number,
      flipBackTimeout: numeric['--flipback-timeout'] as number,
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseDevVerifyArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${DEV_VERIFY_USAGE}`);
    process.exit(2);
  }
  const { sha, probeScript, imageTimeout, flipBackTimeout } = parsed.args;

  const emit = (o: Record<string, unknown>) => console.log(`AUTOLOOP_DEV_VERIFY_RESULT ${JSON.stringify(o)}`);

  // Confirm the box is up before touching the channel.
  if (!(await waitHealth(120))) {
    emit({ reachedDev: false, flippedBack: false, detail: 'box not reachable before flip' });
    process.exit(2);
  }

  // Pre-pull :dev in the background so the flip is a cache-hit (survives the
  // exec caps — memory feedback_box_update_slow_pull_timeout).
  await mcpExec('systemd-run --user --unit=sb-prepull-dev --quiet podman pull ghcr.io/mdopp/servicebay:dev || true').catch(() => {});

  let reachedDev = false;
  let devImage: DevImageResult | null = null;
  let probeExit = -1;
  let probeOutput = '';
  try {
    // Flip to :dev and wait for the SHA's image to be live + healthy.
    await setChannel('dev');
    // Not a settle window: the OUTGOING container keeps answering /api/health
    // right through the flip (#2387), so the revision poll below — not this
    // wait — is the authority on whether the :dev image is actually live.
    await waitHealth(180);
    devImage = await confirmDevImage(
      sha,
      { readRevision: runningRevision, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now() },
      { timeoutSec: imageTimeout },
    );
    reachedDev = devImage.reached;
    if (reachedDev) await waitHealth(180);
    if (!reachedDev) {
      probeOutput = `did not confirm :dev image with revision ${sha}: ${devImage.detail}`;
    } else {
      // Run the agent-supplied probes against the box on :dev.
      try {
        probeOutput = execFileSync('bash', [probeScript], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
        probeExit = 0;
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
        probeExit = typeof err.status === 'number' ? err.status : 1;
        probeOutput = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
      }
    }
  } finally {
    // STRUCTURAL INVARIANT: always flip back to :latest, whatever happened above.
    // Confirmation tolerates the full restart window (#2387) — a null/stale
    // read is "not yet", only budget exhaustion is a verdict.
    const back = await confirmFlipBack(
      {
        setChannel: target => setChannel(target),
        waitHealth: timeoutSec => waitHealth(timeoutSec),
        getChannel,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        now: () => Date.now(),
      },
      { timeoutSec: flipBackTimeout },
    );
    const { flippedBack, channel } = back;
    emit({
      reachedDev,
      probeExit,
      flippedBack,
      channel,
      // Evidence behind reachedDev, so a `false` is diagnosable from the result
      // line alone — reads:0 means "the box never answered", not "no :dev image"
      // (#2493). No manual list_containers cross-check needed either way.
      devImage: devImage
        ? {
            revision: devImage.revision,
            reads: devImage.reads,
            readFailures: devImage.readFailures,
            detail: devImage.detail,
          }
        : null,
      flipBack: { reissues: back.reissues, polls: back.polls, detail: back.detail },
      probeOutput: probeOutput.slice(0, 4000),
    });
    if (!flippedBack) process.exit(5); // box may be stranded on :dev — hard alert
    if (!reachedDev) process.exit(2);
    process.exit(0);
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('autoloop-dev-verify.ts') || invoked.endsWith('autoloop-dev-verify.js')) {
  main().catch(e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
