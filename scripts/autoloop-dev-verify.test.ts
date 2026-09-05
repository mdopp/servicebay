import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDevVerifyMarker,
  clearDevVerifyMarker,
  decideChannelRecovery,
  isHarnessProcessAlive,
  markerBudgetSec,
  readDevVerifyMarker,
  recoverExitCode,
  recoverStrandedChannel,
  writeDevVerifyMarker,
  DEV_VERIFY_MARKER_PATH,
  type ChannelRecoveryDeps,
  type DevVerifyMarker,
} from './autoloop-dev-verify';
import {
  revisionMatchesSha,
  confirmFlipBack,
  confirmDevImage,
  parseDevVerifyArgs,
  pickServicebayRevision,
  runDevVerify,
  devVerifyResultLine,
  devVerifyExitCode,
  describeError,
  DEV_IMAGE_TIMEOUT_SEC,
  DEV_PUSH_TIMEOUT_SEC,
  FLIP_BACK_TIMEOUT_SEC,
  isPullInProgressTimeout,
  pickReleaseRun,
  waitForDevPush,
  type DevImageDeps,
  type DevImageResult,
  type DevVerifyOutcome,
  type DevPushDeps,
  type DevPushResult,
  type DevVerifyRunDeps,
  type DevVerifyStep,
  type FlipBackDeps,
  type FlipBackResult,
} from './autoloop-dev-verify';

const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 40-char git sha
const SHORT = 'a1b2c3d4'; // harness's short sha

describe('revisionMatchesSha', () => {
  it('accepts the full revision label against the short expected sha (prefix match)', () => {
    expect(revisionMatchesSha(FULL, SHORT)).toBe(true);
  });

  it('accepts the full revision label against the full expected sha', () => {
    expect(revisionMatchesSha(FULL, FULL)).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(revisionMatchesSha(`  ${FULL.toUpperCase()}\n`, SHORT)).toBe(true);
  });

  it('rejects a different sha even if it shares no prefix', () => {
    expect(revisionMatchesSha(FULL, 'deadbeef')).toBe(false);
  });

  it('REJECTS a tag name (…:dev) as a non-match — the old bug', () => {
    expect(revisionMatchesSha('ghcr.io/mdopp/servicebay:dev', SHORT)).toBe(false);
    expect(revisionMatchesSha('dev', SHORT)).toBe(false);
  });

  it('rejects an empty revision label (image not built / not readable)', () => {
    expect(revisionMatchesSha('', SHORT)).toBe(false);
    expect(revisionMatchesSha('   ', FULL)).toBe(false);
  });

  it('rejects an empty or non-hex expected sha rather than matching everything', () => {
    expect(revisionMatchesSha(FULL, '')).toBe(false);
    expect(revisionMatchesSha(FULL, ':dev')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// confirmFlipBack (#2387) — the flip-back confirmation's restart tolerance.
//
// A simulated box on a virtual clock, so a 900s budget costs no wall time. The
// timeline knobs are all in ms measured from the moment the box ACCEPTS the
// first `setChannel('latest')` POST; before that the box is up and on `:dev`.
// ---------------------------------------------------------------------------

const NEVER = Number.MAX_SAFE_INTEGER;

interface BoxScript {
  /** When the box stops answering `/api/health` (0 = immediately on the POST). */
  downFromMs: number;
  /** When `/api/health` answers again (200/401). */
  healthUpAtMs: number;
  /** When `/api/system/channel` stops erroring — before this `getChannel()` is `null`. */
  channelReadableAtMs: number;
  /** When the channel endpoint starts reporting `latest`; `null` = never (stuck). */
  latestAtMs: number | null;
  /** What a readable-but-not-yet-flipped box reports (the stale outgoing container). */
  staleChannel?: string;
}

function makeFakeBox(script: BoxScript) {
  let t = 0; // virtual clock, ms
  let acceptedAt: number | null = null;
  const stale = script.staleChannel ?? 'dev';
  /** ms since the flip POST was accepted; -1 while no POST has landed yet. */
  const since = () => (acceptedAt === null ? -1 : t - acceptedAt);
  const healthUp = () => {
    const s = since();
    return s < 0 || s < script.downFromMs || s >= script.healthUpAtMs;
  };
  const channel = (): string | null => {
    const s = since();
    if (s < 0) return stale;
    if (!healthUp() || s < script.channelReadableAtMs) return null;
    return script.latestAtMs !== null && s >= script.latestAtMs ? 'latest' : stale;
  };

  const stats = { posts: 0, postThrows: 0, getChannelCalls: 0 };

  const deps: FlipBackDeps = {
    now: () => t,
    sleep: async ms => {
      t += ms;
    },
    setChannel: async () => {
      // A restarting box refuses the admin login / POST outright.
      if (!healthUp()) {
        stats.postThrows++;
        throw new Error('setChannel(latest) failed: HTTP 502');
      }
      stats.posts++;
      // A re-issued POST against an already-converging box is a no-op — the
      // first accepted flip owns the timeline.
      if (acceptedAt === null) acceptedAt = t;
    },
    waitHealth: async timeoutSec => {
      const deadline = t + timeoutSec * 1000;
      if (healthUp()) return true;
      const upAt = (acceptedAt ?? t) + script.healthUpAtMs;
      if (upAt <= deadline) {
        t = upAt;
        return true;
      }
      t = deadline;
      return false;
    },
    getChannel: async () => {
      stats.getChannelCalls++;
      t += 500; // the call itself costs a little time
      return channel();
    },
  };
  return { deps, stats, elapsedMs: () => t };
}

/** The pre-#2387 confirmation loop, verbatim. Kept ONLY as a fixture check: it
 *  proves each scenario below genuinely reproduces one of the three observed
 *  false negatives, so the new-behaviour assertions aren't testing thin air. */
async function legacyConfirm(deps: FlipBackDeps): Promise<{ flippedBack: boolean; channel: string | null }> {
  let channel: string | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      await deps.setChannel('latest');
      await deps.waitHealth(180);
      channel = await deps.getChannel();
      if (channel === 'latest') break;
    } catch {
      /* retry */
    }
  }
  return { flippedBack: channel === 'latest', channel };
}

/** The three shapes observed live on 2026-07-27 (#2387), each one a box that
 *  DID land back on `:latest` but was reported `flippedBack:false`/exit 5. */
const FALSE_NEGATIVES: Array<{ name: string; legacyChannel: string | null; script: BoxScript }> = [
  {
    // Run 1: reachedDev:false, flippedBack:false, channel:null.
    // Box goes down on the POST and stays down past the single waitHealth(180)
    // budget; the two remaining rounds are burned instantly by setChannel throws.
    name: 'run 1 — reachedDev:false, channel:null (box still restarting past waitHealth(180))',
    legacyChannel: null,
    script: { downFromMs: 0, healthUpAtMs: 200_000, channelReadableAtMs: 200_000, latestAtMs: 210_000 },
  },
  {
    // Run 2: reachedDev:true, probeExit:1, flippedBack:false, channel:"dev".
    // The OUTGOING container keeps answering, so waitHealth returns true
    // instantly and every round reads the stale "dev" within seconds.
    name: 'run 2 — channel stale "dev" (outgoing container still answering)',
    legacyChannel: 'dev',
    script: { downFromMs: NEVER, healthUpAtMs: 0, channelReadableAtMs: 0, latestAtMs: 200_000 },
  },
  {
    // Run 3: reachedDev:true, probeExit:0, flippedBack:false, channel:null.
    // /api/health answers early (auth-gated 401 from a booting app) while
    // /api/system/channel is still 5xx — waitHealth provides no settle time.
    name: 'run 3 — channel:null while health already answers (health up before the API)',
    legacyChannel: null,
    script: { downFromMs: 0, healthUpAtMs: 40_000, channelReadableAtMs: 300_000, latestAtMs: 300_000 },
  },
];

describe('confirmFlipBack (#2387)', () => {
  it('tolerates a restart window at least as generously as the flip-to-:dev wait', () => {
    // Flip-to-:dev budget: waitHealth(180) + waitForDevImage(900) + waitHealth(180).
    expect(FLIP_BACK_TIMEOUT_SEC).toBeGreaterThanOrEqual(900);
  });

  describe.each(FALSE_NEGATIVES)('$name', ({ legacyChannel, script }) => {
    it('WAS a false negative under the pre-fix 3-round loop (fixture check)', async () => {
      const box = makeFakeBox(script);
      await expect(legacyConfirm(box.deps)).resolves.toEqual({ flippedBack: false, channel: legacyChannel });
    });

    it('now resolves to flippedBack:true — the box really did return to :latest', async () => {
      const box = makeFakeBox(script);
      const result = await confirmFlipBack(box.deps);
      expect(result.flippedBack).toBe(true);
      expect(result.channel).toBe('latest');
      // Confirmed from inside the harness's own run, well inside the budget.
      expect(box.elapsedMs()).toBeLessThan(FLIP_BACK_TIMEOUT_SEC * 1000);
    });
  });

  it('still hard-alerts on a box GENUINELY stuck on :dev — and reports the stuck channel', async () => {
    const box = makeFakeBox({ downFromMs: NEVER, healthUpAtMs: 0, channelReadableAtMs: 0, latestAtMs: null });
    const result = await confirmFlipBack(box.deps);
    expect(result.flippedBack).toBe(false);
    expect(result.channel).toBe('dev'); // the diagnostic that says "stranded", not "unreadable"
    expect(result.detail).toContain('stranded');
    // It kept re-issuing the flip rather than giving up after 3 rounds…
    expect(box.stats.posts).toBeGreaterThan(1);
    // …and it still RETURNS, bounded by the budget (never an unbounded wait).
    expect(box.elapsedMs()).toBeLessThanOrEqual((FLIP_BACK_TIMEOUT_SEC + 60) * 1000);
  });

  it('still hard-alerts on a box that never answers at all (channel:null)', async () => {
    const box = makeFakeBox({ downFromMs: 0, healthUpAtMs: NEVER, channelReadableAtMs: NEVER, latestAtMs: null });
    const result = await confirmFlipBack(box.deps);
    expect(result.flippedBack).toBe(false);
    expect(result.channel).toBeNull();
    expect(result.detail).toContain('never reported a channel');
    expect(box.elapsedMs()).toBeLessThanOrEqual((FLIP_BACK_TIMEOUT_SEC + 60) * 1000);
  });

  it('returns immediately on the happy path — one POST, one poll, no wasted budget', async () => {
    const box = makeFakeBox({ downFromMs: NEVER, healthUpAtMs: 0, channelReadableAtMs: 0, latestAtMs: 0 });
    const result = await confirmFlipBack(box.deps);
    expect(result).toMatchObject({ flippedBack: true, channel: 'latest', reissues: 1, polls: 1 });
    expect(box.elapsedMs()).toBeLessThan(5_000);
  });

  it('does not treat a setChannel throw as a verdict — the earlier POST may already have landed', async () => {
    // The box accepts the very first POST, then refuses every later one while
    // it restarts. The flip DID land; only the confirmation must survive.
    const box = makeFakeBox({ downFromMs: 0, healthUpAtMs: 400_000, channelReadableAtMs: 400_000, latestAtMs: 400_000 });
    const result = await confirmFlipBack(box.deps);
    expect(result.flippedBack).toBe(true);
    expect(box.stats.postThrows).toBeGreaterThan(0); // it really did hit the throwing path
    expect(box.stats.posts).toBe(1); // …and never needed a second accepted POST
  });
});

// ---------------------------------------------------------------------------
// confirmDevImage (#2493) — the `reachedDev` false-negative race.
//
// Same shape as the confirmFlipBack fixtures: a simulated box on a virtual
// clock, so a 900s budget costs no wall time.
// ---------------------------------------------------------------------------

/** A valid-but-different 40-char hex revision — the OUTGOING `:latest` image,
 *  which keeps being reported until the flip's restart actually completes. */
const OLD = 'f'.repeat(40);

interface ImageScript {
  /** When the running container starts reporting the TARGET revision. */
  liveAtMs: number;
  /** Reads fail (`null` — `/mcp` down mid-restart) before this. */
  readFailsUntilMs?: number;
  /** What one `podman inspect` round-trip costs on the virtual clock. */
  readCostMs?: number;
}

function makeFakeImageBox(script: ImageScript) {
  let t = 0;
  const stats = { reads: 0, failures: 0 };
  const deps: DevImageDeps = {
    now: () => t,
    sleep: async ms => {
      t += ms;
    },
    readRevision: async () => {
      t += script.readCostMs ?? 1_000; // an /mcp exec round-trip isn't free
      if (t < (script.readFailsUntilMs ?? 0)) {
        stats.failures++;
        return null;
      }
      stats.reads++;
      return t >= script.liveAtMs ? FULL : OLD;
    },
  };
  return { deps, stats, elapsedMs: () => t };
}

/** The pre-#2493 wait loop, verbatim: deadline checked at the TOP, a fixed 20s
 *  cadence, and a failed read collapsed to `''`. Kept only as a fixture check so
 *  the assertions below aren't testing thin air. */
async function legacyWaitForDevImage(sha: string, deps: DevImageDeps, timeoutSec: number): Promise<boolean> {
  const deadline = deps.now() + timeoutSec * 1000;
  while (deps.now() < deadline) {
    const revision = (await deps.readRevision()) ?? ''; // the old failure/mismatch collapse
    if (revisionMatchesSha(revision, sha)) return true;
    await deps.sleep(20_000);
  }
  return false;
}

// The revision read goes through the `list_containers` READ tool (#2623) — the
// labels are already in that payload, so the harness's load-bearing "which image
// is running" confirmation no longer needs the `exec` scope.
describe('pickServicebayRevision', () => {
  const row = (names: string[], labels?: Record<string, string>) => ({ names, labels });

  it('reads the revision label off the servicebay container', () => {
    expect(pickServicebayRevision([
      row(['media-jellyfin'], { 'org.opencontainers.image.revision': 'deadbeef' }),
      row(['servicebay'], { 'org.opencontainers.image.revision': FULL, 'org.opencontainers.image.version': '5.16.0' }),
    ])).toBe(FULL);
  });

  it('returns null when the container is absent (mid-restart) — a FAILED read, not "no label"', () => {
    expect(pickServicebayRevision([row(['media-jellyfin'], {})])).toBeNull();
    expect(pickServicebayRevision([])).toBeNull();
  });

  it("returns '' when the container is there but its image carries no revision label", () => {
    expect(pickServicebayRevision([row(['servicebay'], {})])).toBe('');
    expect(pickServicebayRevision([row(['servicebay'])])).toBe('');
  });

  it('never mistakes the image TAG for a revision (the original #2387 bug)', () => {
    // A row whose only hint is the tag must not yield something that could
    // prefix-match a sha — `revisionMatchesSha` rejects non-hex anyway.
    expect(revisionMatchesSha(pickServicebayRevision([row(['servicebay'], {})]) ?? '', SHORT)).toBe(false);
  });
});

describe('confirmDevImage (#2493)', () => {
  it('waits at least as long as the documented image budget', () => {
    expect(DEV_IMAGE_TIMEOUT_SEC).toBeGreaterThanOrEqual(900);
  });

  it('sees an image that lands inside the last poll gap — the trailing blind window', async () => {
    // Image goes live at 895s: after the old loop's final read (883s) but before
    // its budget (900s), i.e. exactly the window it never looked at again.
    const script: ImageScript = { liveAtMs: 895_000 };

    const legacy = makeFakeImageBox(script);
    await expect(legacyWaitForDevImage(SHORT, legacy.deps, DEV_IMAGE_TIMEOUT_SEC)).resolves.toBe(false); // fixture

    const box = makeFakeImageBox(script);
    const result = await confirmDevImage(SHORT, box.deps);
    expect(result.reached).toBe(true);
    expect(result.revision).toBe(FULL);
  });

  it('reports reads:0 with an explicit "not evidence" detail when the box never answered', async () => {
    // Every read fails for the whole budget. The old loop returned the SAME
    // false as a genuinely stale image, with a "build likely stuck" detail.
    const box = makeFakeImageBox({ liveAtMs: 0, readFailsUntilMs: Number.MAX_SAFE_INTEGER });
    const result = await confirmDevImage(SHORT, box.deps);
    expect(result).toMatchObject({ reached: false, reads: 0, revision: null });
    expect(result.readFailures).toBeGreaterThan(0);
    expect(result.detail).toContain('never read the running image revision');
    expect(result.detail).toContain('NOT evidence');
    expect(box.elapsedMs()).toBeLessThanOrEqual((DEV_IMAGE_TIMEOUT_SEC + 60) * 1000); // still bounded
  });

  it('does not treat a failed read as a verdict — /mcp is down mid-flip by design', async () => {
    const box = makeFakeImageBox({ liveAtMs: 610_000, readFailsUntilMs: 600_000 });
    const result = await confirmDevImage(SHORT, box.deps);
    expect(result.reached).toBe(true);
    expect(result.readFailures).toBeGreaterThan(0); // it really did hit the failing path
  });

  it('falls back to the default budget instead of skipping the wait on a non-finite timeout', async () => {
    // `Number('')`/`Number(undefined)` used to reach here as NaN, making the
    // deadline NaN → `now() < NaN` false → an instant, wait-free false negative.
    const script: ImageScript = { liveAtMs: 100_000 };

    const legacy = makeFakeImageBox(script);
    await expect(legacyWaitForDevImage(SHORT, legacy.deps, Number.NaN)).resolves.toBe(false); // fixture
    expect(legacy.stats.reads).toBe(0); // …without a single look at the box

    const box = makeFakeImageBox(script);
    const result = await confirmDevImage(SHORT, box.deps, { timeoutSec: Number.NaN });
    expect(result.reached).toBe(true);
    expect(box.stats.reads).toBeGreaterThan(0);
  });

  it('still reports false — and says so — for an image that genuinely never lands', async () => {
    const box = makeFakeImageBox({ liveAtMs: Number.MAX_SAFE_INTEGER });
    const result = await confirmDevImage(SHORT, box.deps);
    expect(result.reached).toBe(false);
    expect(result.reads).toBeGreaterThan(0);
    expect(result.revision).toBe(OLD); // the outgoing image, read successfully
    expect(result.detail).toContain('still in flight');
    expect(box.elapsedMs()).toBeLessThanOrEqual((DEV_IMAGE_TIMEOUT_SEC + 60) * 1000);
  });

  it('returns immediately on the happy path — one read, no wasted budget', async () => {
    const box = makeFakeImageBox({ liveAtMs: 0 });
    const result = await confirmDevImage(SHORT, box.deps);
    expect(result).toMatchObject({ reached: true, reads: 1, readFailures: 0 });
    expect(box.elapsedMs()).toBeLessThan(5_000);
  });
});

describe('parseDevVerifyArgs (#2493)', () => {
  const ok = (argv: string[]) => {
    const r = parseDevVerifyArgs(argv);
    if ('error' in r) throw new Error(`expected a parse, got error: ${r.error}`);
    return r.args;
  };
  const err = (argv: string[]) => {
    const r = parseDevVerifyArgs(argv);
    if (!('error' in r)) throw new Error('expected a parse error');
    return r.error;
  };

  it('parses the canonical invocation with the documented defaults', () => {
    expect(ok([SHORT, '--probe-script', '/tmp/probes.sh'])).toEqual({
      sha: SHORT,
      probeScript: '/tmp/probes.sh',
      imageTimeout: DEV_IMAGE_TIMEOUT_SEC,
      flipBackTimeout: FLIP_BACK_TIMEOUT_SEC,
      pushTimeout: DEV_PUSH_TIMEOUT_SEC,
      assumePushed: false,
    });
  });

  it('binds the SHA correctly when the flag comes FIRST — the old mis-parse', () => {
    // `argv.find(a => !a.startsWith('--'))` used to pick /tmp/probes.sh as the
    // SHA; non-hex, so no revision could ever match → guaranteed false negative.
    expect(ok(['--probe-script', '/tmp/probes.sh', SHORT])).toMatchObject({ sha: SHORT, probeScript: '/tmp/probes.sh' });
  });

  it('accepts --opt=value as well as --opt value', () => {
    expect(ok([SHORT, '--probe-script=/tmp/p.sh', '--image-timeout=1200'])).toMatchObject({
      probeScript: '/tmp/p.sh',
      imageTimeout: 1200,
    });
  });

  it('rejects a missing or non-numeric timeout instead of silently going NaN', () => {
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--image-timeout'])).toContain('--image-timeout');
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--image-timeout', 'soon'])).toContain('--image-timeout');
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--flipback-timeout', '0'])).toContain('--flipback-timeout');
  });

  it('takes --push-timeout and the boolean --assume-pushed (#2820)', () => {
    expect(ok([SHORT, '--probe-script', '/tmp/p.sh', '--push-timeout', '120', '--assume-pushed'])).toMatchObject({
      pushTimeout: 120,
      assumePushed: true,
    });
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--push-timeout', 'later'])).toContain('--push-timeout');
    // A value would silently be bound as the SHA positional instead.
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--assume-pushed=yes'])).toContain('takes no value');
  });

  it('rejects a non-SHA positional up front rather than after a 900s wait', () => {
    expect(err(['/tmp/probes.sh', '--probe-script', '/tmp/probes.sh'])).toContain('git SHA');
    expect(err(['dev', '--probe-script', '/tmp/probes.sh'])).toContain('git SHA');
  });

  it('rejects a missing sha / probe script / unknown option / extra positional', () => {
    expect(err(['--probe-script', '/tmp/p.sh'])).toContain('missing <sha>');
    expect(err([SHORT])).toContain('--probe-script');
    expect(err([SHORT, '--probe-script', '/tmp/p.sh', '--nope', '1'])).toContain('unknown option');
    expect(err([SHORT, 'extra', '--probe-script', '/tmp/p.sh'])).toContain('extra argument');
  });
});

// ---------------------------------------------------------------------------
// runDevVerify (#2622) — a failure must always carry a NAMED reason.
//
// The live 2026-08-25 08:03 run emitted
//   {"reachedDev":false,"probeExit":-1,"flippedBack":true,"channel":"latest",
//    "devImage":null,"flipBack":{…},"probeOutput":""}
// — no reason anywhere, and an early abort instead of the 900s window. Cause:
// the flip/confirm block was a `try` with a `finally` and NO `catch`, and the
// `finally` called `process.exit()`, which discards the pending exception.
// ---------------------------------------------------------------------------

const REACHED: DevImageResult = {
  reached: true,
  revision: FULL,
  reads: 1,
  readFailures: 0,
  detail: `:dev image with revision ${FULL} live after 1 read(s), 0 failed read(s)`,
};
const NOT_PUBLISHED: DevImageResult = {
  reached: false,
  revision: OLD,
  reads: 71,
  readFailures: 1,
  detail: `running image revision ${OLD} never matched ${SHORT} within 900s (71 read(s), 1 failed read(s)) — :dev build likely still in flight`,
};
const FLIPPED_BACK: FlipBackResult = {
  flippedBack: true,
  channel: 'latest',
  reissues: 1,
  polls: 2,
  detail: 'confirmed :latest after 2 poll(s)',
};

const RUN_OPTS = {
  imageTimeout: DEV_IMAGE_TIMEOUT_SEC,
  flipBackTimeout: FLIP_BACK_TIMEOUT_SEC,
  pushTimeout: DEV_PUSH_TIMEOUT_SEC,
};

const PUSHED: DevPushResult = {
  pushed: true,
  runId: 4242,
  status: 'completed',
  conclusion: 'success',
  polls: 1,
  lookupFailures: 0,
  detail: `Release run 4242 for ${SHORT} completed success after 1 lookup(s) — :dev is on the registry`,
};
const NOT_PUSHED: DevPushResult = {
  pushed: false,
  runId: 4242,
  status: 'in_progress',
  conclusion: null,
  polls: 60,
  lookupFailures: 0,
  detail: `Release run 4242 for ${SHORT} still in_progress after 900s (60 lookup(s), 0 failed lookup(s)) — the :dev image is not on the registry yet`,
};

function makeRunDeps(overrides: Partial<DevVerifyRunDeps> = {}) {
  const calls = { flipBacks: 0, probes: 0, setChannel: 0, pushWaits: 0 };
  const deps: DevVerifyRunDeps = {
    waitForDevPush: async () => {
      calls.pushWaits++;
      return PUSHED;
    },
    setChannel: async () => {
      calls.setChannel++;
    },
    waitHealth: async () => true,
    confirmDevImage: async () => REACHED,
    runProbe: async () => {
      calls.probes++;
      return { exit: 0, output: 'probe ok' };
    },
    flipBack: async () => {
      calls.flipBacks++;
      return FLIPPED_BACK;
    },
    ...overrides,
  };
  // Count the flip-backs even when the caller supplies its own implementation:
  // the "it always fires" assertions must not depend on the default dep.
  const wrapped: DevVerifyRunDeps = {
    ...deps,
    flipBack: async timeoutSec => {
      if (overrides.flipBack) calls.flipBacks++;
      return (overrides.flipBack ?? deps.flipBack)(timeoutSec);
    },
  };
  return { deps: wrapped, calls };
}

const boom = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

/** Every step that can abort *before* the probes, plus the probe capture — each
 *  paired with the dep whose throw lands there. */
const ABORT_CASES: Array<{ step: DevVerifyStep; deps: () => Partial<DevVerifyRunDeps>; devImageSeen: boolean }> = [
  {
    // The live case: the flip POST against a box still restarting from the
    // previous run's flip-back. `/mcp` lives in the app being restarted.
    step: 'flip-to-dev',
    deps: () => ({ setChannel: boom('mcp set_channel failed (HTTP 502): bad gateway') }),
    devImageSeen: false,
  },
  { step: 'health-after-flip', deps: () => ({ waitHealth: boom('fetch failed: ECONNRESET') }), devImageSeen: false },
  {
    step: 'confirm-dev-image',
    deps: () => ({ confirmDevImage: boom('mcpExec: could not parse /mcp response (HTTP 401)') }),
    devImageSeen: false,
  },
  {
    step: 'health-on-dev',
    // The first wait (health-after-flip) succeeds, the post-image one throws.
    // A factory, not a shared object: the counter must reset per test case.
    deps: () => {
      let n = 0;
      return {
        waitHealth: async () => {
          if (++n > 1) throw new Error('fetch failed: socket hang up');
          return true;
        },
      };
    },
    devImageSeen: true,
  },
  { step: 'probe-script', deps: () => ({ runProbe: boom('spawnSync bash EAGAIN') }), devImageSeen: true },
];

describe('runDevVerify (#2622) — no blind failures', () => {
  describe.each(ABORT_CASES)('abort at $step', ({ step, deps: makeOverrides, devImageSeen }) => {
    it('names the step and the error instead of returning a bare devImage:null', async () => {
      const { deps } = makeRunDeps(makeOverrides());
      const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);

      expect(outcome.failure).not.toBeNull();
      expect(outcome.failure?.step).toBe(step);
      expect(outcome.failure?.message).toBeTruthy();
      // …and the reason is visible in the field a reader looks at first.
      expect(outcome.probeOutput).not.toBe('');
      if (!devImageSeen) expect(outcome.devImage).toBeNull();
    });

    it('emits a result line that can never be the blind 08:03 shape', async () => {
      const { deps } = makeRunDeps(makeOverrides());
      const line = devVerifyResultLine(await runDevVerify(SHORT, deps, RUN_OPTS));
      const blind = line.devImage === null && line.failure === null;
      expect(blind).toBe(false);
      expect(line.probeOutput).not.toBe('');
      expect(JSON.stringify(line.failure)).toContain(step);
    });

    it('STILL flips back — the finally fires on this path too', async () => {
      const { deps, calls } = makeRunDeps(makeOverrides());
      const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
      expect(calls.flipBacks).toBe(1);
      expect(outcome.flipBack.flippedBack).toBe(true);
      expect(devVerifyResultLine(outcome).flippedBack).toBe(true);
    });

    it('is exit 2 (harness failure), never a silent exit 0', async () => {
      const { deps } = makeRunDeps(makeOverrides());
      expect(devVerifyExitCode(await runDevVerify(SHORT, deps, RUN_OPTS))).toBe(2);
    });
  });

  it('keeps "image not published yet" DISTINGUISHABLE from "the run failed at step X"', async () => {
    const clean = await runDevVerify(SHORT, makeRunDeps({ confirmDevImage: async () => NOT_PUBLISHED }).deps, RUN_OPTS);
    const aborted = await runDevVerify(
      SHORT,
      makeRunDeps({ setChannel: boom('mcp set_channel failed (HTTP 502)') }).deps,
      RUN_OPTS,
    );

    // Same reachedDev, same exit code — the difference must be readable from the
    // result object itself, which is the whole acceptance criterion.
    expect(clean.reachedDev).toBe(false);
    expect(aborted.reachedDev).toBe(false);
    expect(devVerifyExitCode(clean)).toBe(devVerifyExitCode(aborted));

    const cleanLine = devVerifyResultLine(clean);
    expect(cleanLine.failure).toBeNull(); // the harness ran its full wait
    expect(JSON.stringify(cleanLine.devImage)).toContain('still in flight');
    expect(String(cleanLine.probeOutput)).toContain('still in flight');

    const abortedLine = devVerifyResultLine(aborted);
    expect(abortedLine.failure).toMatchObject({ step: 'flip-to-dev' });
    expect(String(abortedLine.probeOutput)).toContain('flip-to-dev');
    expect(abortedLine.devImage).toBeNull();
  });

  it('reports a probe RED as a probe result, not as a harness failure', async () => {
    const { deps } = makeRunDeps({ runProbe: async () => ({ exit: 1, output: 'probe: nginx -t failed' }) });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome).toMatchObject({ reachedDev: true, probeExit: 1, failure: null });
    expect(devVerifyExitCode(outcome)).toBe(0); // the LLM judges probeOutput
  });

  it('runs clean on the happy path — no failure, exit 0, flipped back', async () => {
    const { deps, calls } = makeRunDeps();
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome).toMatchObject({ reachedDev: true, probeExit: 0, failure: null });
    expect(calls.probes).toBe(1);
    expect(calls.flipBacks).toBe(1);
    expect(devVerifyExitCode(outcome)).toBe(0);
  });

  it('does not run the probes when the :dev image never landed', async () => {
    const { deps, calls } = makeRunDeps({ confirmDevImage: async () => NOT_PUBLISHED });
    await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(calls.probes).toBe(0);
    expect(calls.flipBacks).toBe(1);
  });
});

describe('the flip-back guarantee is unchanged (#2387/#2622 criterion 3)', () => {
  it('fires exactly once on EVERY path — success, image-missing, and each abort step', async () => {
    const paths: Array<Partial<DevVerifyRunDeps>> = [
      {}, // happy
      { confirmDevImage: async () => NOT_PUBLISHED },
      { runProbe: async () => ({ exit: 3, output: 'red' }) },
      ...ABORT_CASES.map(c => c.deps()),
    ];
    for (const overrides of paths) {
      const { deps, calls } = makeRunDeps(overrides);
      await runDevVerify(SHORT, deps, RUN_OPTS);
      expect(calls.flipBacks).toBe(1);
    }
  });

  it('never lets an abort escape as an exception — a throwing run still RETURNS a result', async () => {
    // The old shape lost the exception to `process.exit` inside the `finally`.
    // Whatever happens, the caller gets an outcome it can emit and act on.
    const { deps } = makeRunDeps({ setChannel: boom('anything at all') });
    await expect(runDevVerify(SHORT, deps, RUN_OPTS)).resolves.toMatchObject({ reachedDev: false });
  });

  it('turns a THROWING flip-back into flippedBack:false + exit 5, not an escaped error', async () => {
    const { deps } = makeRunDeps({ flipBack: boom('mcp set_channel failed (HTTP 500)') });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome.flipBack.flippedBack).toBe(false);
    expect(outcome.flipBack.detail).toContain('stranded');
    expect(outcome.failure).toMatchObject({ step: 'flip-back' });
    expect(devVerifyExitCode(outcome)).toBe(5); // hard alert — box may be on :dev
  });

  it('keeps exit 5 dominant even when the run itself was green', async () => {
    const stuck: FlipBackResult = {
      flippedBack: false,
      channel: 'dev',
      reissues: 5,
      polls: 60,
      detail: 'box still reports :dev after 900s (60 poll(s), 5 flip POST(s)) — stranded on :dev',
    };
    const { deps } = makeRunDeps({ flipBack: async () => stuck });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome).toMatchObject({ reachedDev: true, probeExit: 0, failure: null });
    expect(devVerifyExitCode(outcome)).toBe(5);
  });

  // Structural half: the behavioural tests above pass whether the flip-back sits
  // in a `finally` or merely runs after a catch-all. The invariant is that it is
  // STRUCTURAL — and that the `finally` never re-grows the `process.exit` that
  // discarded the pending exception in the first place.
  const source = readFileSync('scripts/autoloop-dev-verify.ts', 'utf8');
  const runBody = source.slice(
    source.indexOf('export async function runDevVerify'),
    source.indexOf('export function devVerifyResultLine'),
  );

  it('calls the flip-back from inside a `finally` block', () => {
    expect(runBody).not.toBe('');
    expect(runBody).toMatch(/\}\s*catch\s*\([\s\S]*?\}\s*finally\s*\{[\s\S]*deps\.flipBack\(/);
  });

  it('never calls process.exit inside the run — that is what swallowed the reason', () => {
    expect(runBody).not.toMatch(/process\.exit/);
  });
});

describe('devVerifyResultLine — the last line of defence', () => {
  it('synthesises a named reason if a future edit ever produces the blind shape', () => {
    const blind: DevVerifyOutcome = {
      reachedDev: false,
      devPush: PUSHED,
      devImage: null,
      flipTimeout: null,
      probeExit: -1,
      probeOutput: '',
      failure: null, // the exact 08:03 shape
      flipBack: FLIPPED_BACK,
    };
    const line = devVerifyResultLine(blind);
    expect(line.failure).not.toBeNull();
    expect(JSON.stringify(line.failure)).toContain('#2622');
    expect(String(line.probeOutput)).not.toBe('');
  });

  it('carries the flip-back evidence and the configured channel through unchanged', () => {
    const line = devVerifyResultLine({
      reachedDev: true,
      devPush: PUSHED,
      devImage: REACHED,
      flipTimeout: null,
      probeExit: 0,
      probeOutput: 'ok',
      failure: null,
      flipBack: FLIPPED_BACK,
    });
    expect(line).toMatchObject({
      flippedBack: true,
      channel: 'latest',
      flipBack: { reissues: 1, polls: 2, detail: 'confirmed :latest after 2 poll(s)' },
    });
  });

  it('truncates a huge probeOutput but keeps it non-empty', () => {
    const line = devVerifyResultLine({
      reachedDev: true,
      devPush: PUSHED,
      devImage: REACHED,
      flipTimeout: null,
      probeExit: 0,
      probeOutput: 'x'.repeat(10_000),
      failure: null,
      flipBack: FLIPPED_BACK,
    });
    expect(String(line.probeOutput)).toHaveLength(4000);
  });
});

describe('describeError', () => {
  it('never returns an empty reason, whatever was thrown', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(new Error(''))).toBe('Error'); // an abort with no message
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ code: 'ECONNREFUSED' })).toContain('ECONNREFUSED');
    expect(describeError(undefined)).toBeTruthy();
    expect(describeError(null)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// `get_channel` reports the CONFIGURED channel, not the running image (it said
// `latest` on 2026-08-25 while the box ran :dev @f42dac70). Only the OCI
// revision label off the RUNNING container is authoritative — this guard keeps
// the reachedDev verdict from ever regressing onto the channel read.
// ---------------------------------------------------------------------------

describe('reachedDev never trusts get_channel', () => {
  const source = readFileSync('scripts/autoloop-dev-verify.ts', 'utf8');
  const imageSection = source.slice(
    source.indexOf('async function runningRevision'),
    source.indexOf('// ---------- flip-back confirmation'),
  );
  const runBody = source.slice(
    source.indexOf('export async function runDevVerify'),
    source.indexOf('export function devVerifyResultLine'),
  );

  it('reads the running container\'s revision label, not the channel', () => {
    expect(imageSection).toContain('list_containers');
    expect(imageSection).toContain('org.opencontainers.image.revision');
    expect(imageSection).not.toMatch(/getChannel|get_channel/);
  });

  // #2623 ratchet: the revision read must stay on the read tool. `exec_command`
  // is exec-scoped, and `destroy` no longer implies `exec` — a harness token
  // without an explicit exec grant must still be able to confirm the image.
  it('confirms the image with a read tool, never exec_command', () => {
    expect(imageSection).not.toMatch(/mcpExec|exec_command|podman inspect/);
  });

  it('derives reachedDev from the image confirmation alone', () => {
    expect(runBody).toContain('reachedDev = devImage.reached');
    expect(runBody).not.toMatch(/getChannel|get_channel/);
  });

  it('never lets a channel read stand in for the image verdict', async () => {
    // A box whose configured channel is already `dev` while the OLD image is
    // still running must still report reachedDev:false.
    const { deps } = makeRunDeps({ confirmDevImage: async () => NOT_PUBLISHED });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome.reachedDev).toBe(false);
    expect(devVerifyResultLine(outcome).channel).toBe('latest'); // the flip-back's configured read
    expect(JSON.stringify(devVerifyResultLine(outcome).devImage)).toContain(OLD);
  });
});

// ---------------------------------------------------------------------------
// #2820 — the harness used to flip BEFORE the SHA's `:dev` image existed.
//
// Live shape (2026-09-05, d3238343): flip at 13:02Z, the `:dev` push finished at
// 13:03:51Z, so the box pulled the PREVIOUS digest and the harness read the old
// revision 91× over the whole 900s budget before flipping back — one wasted
// restart cycle, 17 min, and the wrong build live on the box meanwhile. The
// second half of the same race: `set_channel dev` is awaited server-side through
// a multi-minute `podman pull` while the client call gives up after 30s, and
// that abort was treated as a failed flip → immediate flip-back → the `:dev`
// container never started.
//
// Same fixture discipline as `confirmDevImage`: a simulated registry on a
// virtual clock, so a 900s budget costs no wall time and there is no `gh`.
// ---------------------------------------------------------------------------

interface PushScript {
  /** When the Release run flips to completed/success. */
  successAtMs: number;
  /** Lookups fail (`null` — gh offline/rate-limited) before this. */
  lookupFailsUntilMs?: number;
  /** No run exists at all before this (the workflow hasn't registered yet). */
  runAppearsAtMs?: number;
  /** A terminal non-success conclusion, from `runAppearsAtMs` on. */
  failedConclusion?: string;
  /** What one `gh run list` round-trip costs on the virtual clock. */
  lookupCostMs?: number;
}

function makeFakePushRegistry(script: PushScript) {
  let t = 0;
  const stats = { lookups: 0, failures: 0 };
  const deps: DevPushDeps = {
    now: () => t,
    sleep: async ms => {
      t += ms;
    },
    listRuns: async () => {
      t += script.lookupCostMs ?? 1_000; // a gh round-trip isn't free
      if (t < (script.lookupFailsUntilMs ?? 0)) {
        stats.failures++;
        return null;
      }
      stats.lookups++;
      if (t < (script.runAppearsAtMs ?? 0)) return [];
      if (script.failedConclusion) {
        return [{ databaseId: 77, status: 'completed', conclusion: script.failedConclusion }];
      }
      return t >= script.successAtMs
        ? [{ databaseId: 77, status: 'completed', conclusion: 'success' }]
        : [{ databaseId: 77, status: 'in_progress', conclusion: '' }]; // gh emits '' while running
    },
  };
  return { deps, stats, elapsedMs: () => t };
}

describe('pickReleaseRun (#2820)', () => {
  it('returns null for no runs at all — "not yet", never "it failed"', () => {
    expect(pickReleaseRun([])).toBeNull();
  });

  it('lets a completed success win over a newer, still-running row', () => {
    expect(
      pickReleaseRun([
        { databaseId: 2, status: 'in_progress', conclusion: '' },
        { databaseId: 1, status: 'completed', conclusion: 'success' },
      ]),
    ).toMatchObject({ runId: 1, status: 'completed', conclusion: 'success' });
  });

  it('falls back to the newest row (gh lists newest first) when none succeeded', () => {
    expect(
      pickReleaseRun([
        { databaseId: 2, status: 'in_progress', conclusion: '' },
        { databaseId: 1, status: 'completed', conclusion: 'failure' },
      ]),
    ).toMatchObject({ runId: 2, status: 'in_progress' });
  });
});

describe('waitForDevPush (#2820)', () => {
  it('waits at least as long as the documented push budget', () => {
    expect(DEV_PUSH_TIMEOUT_SEC).toBeGreaterThanOrEqual(900);
  });

  it('returns immediately when the image is already pushed — no wasted budget', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 0 });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result).toMatchObject({ pushed: true, runId: 77, conclusion: 'success', polls: 1 });
    expect(reg.elapsedMs()).toBeLessThan(5_000);
  });

  it('waits out the in-flight Release run instead of flipping onto the previous digest', async () => {
    // The live case: the push lands 111s after the merge, i.e. long after the
    // old harness had already flipped.
    const reg = makeFakePushRegistry({ successAtMs: 111_000 });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result.pushed).toBe(true);
    expect(result.polls).toBeGreaterThan(1);
    expect(reg.elapsedMs()).toBeGreaterThanOrEqual(111_000);
  });

  it('sees a push that lands inside the last poll gap — no blind trailing window', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 899_000 });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result.pushed).toBe(true);
  });

  it('does not treat a failed gh lookup as a verdict', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 0, lookupFailsUntilMs: 120_000 });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result.pushed).toBe(true);
    expect(result.lookupFailures).toBeGreaterThan(0); // it really did hit the failing path
  });

  it('reports polls:0 with an explicit "UNKNOWN" detail when gh never answered', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 0, lookupFailsUntilMs: Number.MAX_SAFE_INTEGER });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result).toMatchObject({ pushed: false, polls: 0, runId: null });
    expect(result.detail).toContain('UNKNOWN');
    expect(result.detail).toContain('NOT evidence');
    expect(reg.elapsedMs()).toBeLessThanOrEqual((DEV_PUSH_TIMEOUT_SEC + 60) * 1000); // still bounded
  });

  it('says so plainly when no Release run ever appears for the sha', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 0, runAppearsAtMs: Number.MAX_SAFE_INTEGER });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result).toMatchObject({ pushed: false, status: null });
    expect(result.polls).toBeGreaterThan(0);
    expect(result.detail).toContain('no Release workflow run');
  });

  it('gives up at once on a completed FAILURE — no image is coming, so the budget is not burnt', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 0, failedConclusion: 'failure' });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result).toMatchObject({ pushed: false, status: 'completed', conclusion: 'failure', runId: 77 });
    expect(result.detail).toContain('no :dev image was pushed');
    expect(reg.elapsedMs()).toBeLessThan(5_000);
  });

  it('still reports pushed:false — and says which run — when the build never finishes', async () => {
    const reg = makeFakePushRegistry({ successAtMs: Number.MAX_SAFE_INTEGER });
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result).toMatchObject({ pushed: false, status: 'in_progress' });
    expect(result.detail).toContain('not on the registry yet');
    expect(reg.elapsedMs()).toBeLessThanOrEqual((DEV_PUSH_TIMEOUT_SEC + 60) * 1000);
  });

  it('falls back to the default budget instead of skipping the wait on a non-finite timeout', async () => {
    const reg = makeFakePushRegistry({ successAtMs: 100_000 });
    const result = await waitForDevPush(SHORT, reg.deps, { timeoutSec: Number.NaN });
    expect(result.pushed).toBe(true);
    expect(reg.stats.lookups).toBeGreaterThan(0);
  });
});

describe('waitForDevPush resolves the sha ONCE before polling (#2837)', () => {
  /** A registry that behaves like the real `gh run list --commit`: it answers
   *  ONLY the exact 40-char sha, and returns an empty array (never an error)
   *  for a short one. */
  function exactShaRegistry() {
    let t = 0;
    const shas: string[] = [];
    const deps: DevPushDeps = {
      now: () => t,
      sleep: async ms => {
        t += ms;
      },
      listRuns: async sha => {
        t += 1_000;
        shas.push(sha);
        return sha === FULL ? [{ databaseId: 77, status: 'completed', conclusion: 'success' }] : [];
      },
    };
    return { deps, shas, elapsedMs: () => t };
  }

  it('finds the already-completed Release run for a SHORT sha instead of burning the budget', async () => {
    const reg = exactShaRegistry();
    let resolutions = 0;
    const result = await waitForDevPush(SHORT, {
      ...reg.deps,
      resolveSha: () => {
        resolutions++;
        return FULL;
      },
    });
    expect(result).toMatchObject({ pushed: true, runId: 77, polls: 1 });
    expect(reg.shas).toEqual([FULL]); // polled with the full sha, not the short one
    expect(resolutions).toBe(1); // resolved once, before the loop — never per poll
    expect(reg.elapsedMs()).toBeLessThan(5_000);
  });

  it('is exactly the bug when the sha is NOT resolved — the budget is burnt on an empty answer', async () => {
    const reg = exactShaRegistry();
    const result = await waitForDevPush(SHORT, reg.deps);
    expect(result.pushed).toBe(false);
    expect(result.detail).toContain('no Release workflow run');
    expect(reg.elapsedMs()).toBeGreaterThanOrEqual(DEV_PUSH_TIMEOUT_SEC * 1000);
  });

  it('falls back to the given sha when the resolution fails — no worse than before', async () => {
    const reg = exactShaRegistry();
    const result = await waitForDevPush(FULL, { ...reg.deps, resolveSha: () => null });
    expect(result.pushed).toBe(true);
    expect(reg.shas).toEqual([FULL]);
  });
});

describe('isPullInProgressTimeout (#2820)', () => {
  it('recognises the live client-side abort of the set_channel POST', () => {
    // The exact 13:22Z message: the box is still inside its 5-min podman pull.
    expect(isPullInProgressTimeout('The operation was aborted due to timeout')).toBe(true);
    expect(isPullInProgressTimeout('TimeoutError: signal timed out')).toBe(true);
  });

  it('does NOT swallow a real refusal — those must still abort at flip-to-dev', () => {
    expect(isPullInProgressTimeout('mcp set_channel failed (HTTP 502): bad gateway')).toBe(false);
    expect(isPullInProgressTimeout('setChannel(dev) not accepted: {"ok":false}')).toBe(false);
    expect(isPullInProgressTimeout('scope denied: lifecycle')).toBe(false);
  });
});

describe('runDevVerify — the flip waits for the push (#2820)', () => {
  it('never touches the channel when the sha has no :dev image', async () => {
    const { deps, calls } = makeRunDeps({ waitForDevPush: async () => NOT_PUSHED });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);

    expect(calls.setChannel).toBe(0); // the whole point: the box is untouched
    expect(calls.probes).toBe(0);
    expect(outcome.failure).toMatchObject({ step: 'dev-image-not-pushed' });
    expect(outcome.devImage).toBeNull();
    expect(outcome.reachedDev).toBe(false);
    expect(devVerifyExitCode(outcome)).toBe(2); // harness failure, NOT exit 5
  });

  it('keeps "the image was never pushed" distinct from "the flip POST was refused"', async () => {
    const notPushed = devVerifyResultLine(
      await runDevVerify(SHORT, makeRunDeps({ waitForDevPush: async () => NOT_PUSHED }).deps, RUN_OPTS),
    );
    const flipRefused = devVerifyResultLine(
      await runDevVerify(SHORT, makeRunDeps({ setChannel: boom('mcp set_channel failed (HTTP 502)') }).deps, RUN_OPTS),
    );

    expect(notPushed.failure).toMatchObject({ step: 'dev-image-not-pushed' });
    expect(flipRefused.failure).toMatchObject({ step: 'flip-to-dev' });
    expect(JSON.stringify(notPushed.devPush)).toContain('not on the registry yet');
    expect(String(notPushed.probeOutput)).toContain('dev-image-not-pushed');
  });

  it('does not issue a pointless flip-back when it never flipped', async () => {
    // set_channel recreates + restarts the container even for the channel it is
    // already on, so "flipping back" an untouched box is a wasted restart.
    const { deps, calls } = makeRunDeps({ waitForDevPush: async () => NOT_PUSHED });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(calls.flipBacks).toBe(0);
    expect(outcome.flipBack.flippedBack).toBe(true); // nothing to strand ⇒ never a hard alert
    expect(outcome.flipBack.detail).toContain('never flipped');
  });

  it('names the step when the push lookup itself throws — no blind failure', async () => {
    const { deps, calls } = makeRunDeps({ waitForDevPush: boom('gh: exec format error') });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome.failure).toMatchObject({ step: 'dev-image-not-pushed', message: 'gh: exec format error' });
    expect(calls.setChannel).toBe(0);
    expect(devVerifyResultLine(outcome).probeOutput).not.toBe('');
  });

  it('waits for the push BEFORE flipping, not after', async () => {
    const order: string[] = [];
    const { deps } = makeRunDeps({
      waitForDevPush: async () => {
        order.push('push');
        return PUSHED;
      },
      setChannel: async () => {
        order.push('flip');
      },
    });
    await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(order).toEqual(['push', 'flip']);
  });

  it('carries the push evidence into the result line on the happy path', async () => {
    const line = devVerifyResultLine(await runDevVerify(SHORT, makeRunDeps().deps, RUN_OPTS));
    expect(line.devPush).toMatchObject({ pushed: true, runId: 4242, conclusion: 'success' });
    expect(line.flipTimeout).toBeNull();
  });
});

describe('runDevVerify — a set_channel client timeout is pull-in-progress (#2820)', () => {
  const CLIENT_TIMEOUT = 'mcp set_channel failed (HTTP 0): The operation was aborted due to timeout';

  it('keeps polling for the image budget instead of flipping straight back', async () => {
    const { deps, calls } = makeRunDeps({ setChannel: boom(CLIENT_TIMEOUT) });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);

    // The pre-fix run aborted here (failure:flip-to-dev, reissues:1) and the
    // :dev container never started — which is why every fresh SHA needed two runs.
    expect(outcome.failure).toBeNull();
    expect(outcome.reachedDev).toBe(true);
    expect(outcome.flipTimeout).toBe(CLIENT_TIMEOUT); // recorded, not swallowed
    expect(calls.probes).toBe(1);
    expect(calls.flipBacks).toBe(1); // the flip DID land server-side ⇒ still flip back
    expect(devVerifyExitCode(outcome)).toBe(0);
  });

  it('surfaces the timeout in the result line without calling it a failure', async () => {
    const line = devVerifyResultLine(
      await runDevVerify(SHORT, makeRunDeps({ setChannel: boom(CLIENT_TIMEOUT) }).deps, RUN_OPTS),
    );
    expect(line.failure).toBeNull();
    expect(line.flipTimeout).toBe(CLIENT_TIMEOUT);
    expect(line.reachedDev).toBe(true);
  });

  it('still reports the image verdict when the pull was genuinely too slow', async () => {
    const { deps } = makeRunDeps({
      setChannel: boom(CLIENT_TIMEOUT),
      confirmDevImage: async () => NOT_PUBLISHED,
    });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome).toMatchObject({ reachedDev: false, failure: null });
    expect(outcome.probeOutput).toContain('still in flight');
    expect(devVerifyExitCode(outcome)).toBe(2);
  });

  it('still ABORTS at flip-to-dev on a genuine refusal — the timeout path is not a catch-all', async () => {
    const { deps, calls } = makeRunDeps({ setChannel: boom('mcp set_channel failed (HTTP 403): scope denied') });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome.failure).toMatchObject({ step: 'flip-to-dev' });
    expect(outcome.flipTimeout).toBeNull();
    expect(calls.probes).toBe(0);
    expect(calls.flipBacks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The in-flight marker + `--recover` (#2826).
//
// The 2026-09-05 strand: the orchestrator and its background harness run INSIDE
// the `claude-dev` container, a FULL verify's probes upgraded that very service,
// the container was recreated at 17:24:53Z, and the harness's process tree died
// mid-flip — so the `finally` flip-back never ran and the box sat on `:dev`
// until an operator flipped it back at 17:51Z. A detached child would have died
// with the container too; only state that outlives the container closes this.
// ---------------------------------------------------------------------------

const MARKER_OPTS = { imageTimeout: 900, flipBackTimeout: 900 };
const T0 = Date.parse('2026-09-05T17:23:00.000Z');

function marker(overrides: Partial<DevVerifyMarker> = {}): DevVerifyMarker {
  return { ...buildDevVerifyMarker(SHORT, MARKER_OPTS, { now: T0, pid: 4242 }), ...overrides };
}

describe('buildDevVerifyMarker / markerBudgetSec', () => {
  it('expires after the run’s own budgets, not on a fixed guess', () => {
    const m = marker();
    expect(Date.parse(m.expiresAt) - Date.parse(m.flippedAt)).toBe(markerBudgetSec(MARKER_OPTS) * 1000);
    expect(markerBudgetSec(MARKER_OPTS)).toBeGreaterThan(MARKER_OPTS.imageTimeout + MARKER_OPTS.flipBackTimeout);
  });

  it('records the sha, the pid and the argv fingerprint that pid must carry', () => {
    expect(marker()).toMatchObject({ sha: SHORT, channel: 'dev', pid: 4242, cmdlineMatch: 'autoloop-dev-verify' });
  });
});

describe('the marker file round-trips through a path that outlives the container', () => {
  it('writes, reads back and clears — creating .claude/state if it is missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sb-marker-'));
    try {
      expect(readDevVerifyMarker(DEV_VERIFY_MARKER_PATH, cwd)).toBeNull();
      writeDevVerifyMarker(marker(), DEV_VERIFY_MARKER_PATH, cwd);
      expect(existsSync(join(cwd, DEV_VERIFY_MARKER_PATH))).toBe(true);
      expect(readDevVerifyMarker(DEV_VERIFY_MARKER_PATH, cwd)).toMatchObject({ sha: SHORT, pid: 4242 });
      clearDevVerifyMarker(DEV_VERIFY_MARKER_PATH, cwd);
      expect(readDevVerifyMarker(DEV_VERIFY_MARKER_PATH, cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('lives under the gitignored .claude/state/, and is NOT the broker cache or the verify result file', () => {
    expect(DEV_VERIFY_MARKER_PATH.startsWith('.claude/state/')).toBe(true);
    expect(DEV_VERIFY_MARKER_PATH).not.toContain('autoloop-cache');
    expect(DEV_VERIFY_MARKER_PATH).not.toContain('work-queue');
    expect(DEV_VERIFY_MARKER_PATH).not.toContain('box-verify');
  });

  it('treats a corrupt marker as no marker — nothing can be proven in flight from it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sb-marker-'));
    try {
      writeDevVerifyMarker(marker(), DEV_VERIFY_MARKER_PATH, cwd);
      rmSync(join(cwd, DEV_VERIFY_MARKER_PATH));
      expect(readDevVerifyMarker(DEV_VERIFY_MARKER_PATH, cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('isHarnessProcessAlive', () => {
  it('is alive only when the pid still carries the harness argv', () => {
    expect(isHarnessProcessAlive(marker(), () => 'node .../tsx scripts/autoloop-dev-verify.ts 64b19601')).toBe(true);
  });

  it('is dead when the pid is gone (the container was recreated)', () => {
    expect(isHarnessProcessAlive(marker(), () => null)).toBe(false);
  });

  it('REJECTS a recycled pid — a recreated container restarts pid numbering, so some live process WILL hold it', () => {
    expect(isHarnessProcessAlive(marker(), () => '/usr/bin/node /opt/claude/cli.js')).toBe(false);
  });
});

describe('decideChannelRecovery — a :dev box no live harness owns is stranded (#2826)', () => {
  const alive = { channel: 'dev', marker: marker(), harnessAlive: true, now: T0 + 60_000 };

  it('REPAIRS when the harness that took the flip is gone — the #2826 scenario', () => {
    const d = decideChannelRecovery({ ...alive, harnessAlive: false });
    expect(d.action).toBe('repair');
    expect(d.staleMarker).toBe(true);
    expect(d.reason).toContain('container');
  });

  it('REPAIRS when the box is on :dev with no marker at all (a hand-flip, or a marker lost)', () => {
    expect(decideChannelRecovery({ ...alive, marker: null, harnessAlive: false })).toMatchObject({ action: 'repair' });
  });

  it('REPAIRS when a matching pid is still alive but the run blew its whole budget', () => {
    const past = Date.parse(marker().expiresAt) + 1;
    expect(decideChannelRecovery({ ...alive, now: past })).toMatchObject({ action: 'repair', staleMarker: true });
  });

  it('REPAIRS on a corrupt expiry rather than trusting it', () => {
    expect(decideChannelRecovery({ ...alive, marker: marker({ expiresAt: 'not-a-date' }) })).toMatchObject({
      action: 'repair',
    });
  });

  it('LEAVES a live in-flight run alone — the recovery must not fight the harness', () => {
    const d = decideChannelRecovery(alive);
    expect(d.action).toBe('harness-in-flight');
    expect(d.staleMarker).toBe(false);
  });

  it('does nothing when the box is on :latest, but drops a marker left behind there', () => {
    expect(decideChannelRecovery({ ...alive, channel: 'latest' })).toMatchObject({
      action: 'not-on-dev',
      staleMarker: true,
    });
    expect(decideChannelRecovery({ ...alive, channel: 'latest', marker: null })).toMatchObject({ staleMarker: false });
  });

  it('never flips blind: a null channel is "no answer", not "on :latest"', () => {
    expect(decideChannelRecovery({ ...alive, channel: null, marker: null })).toMatchObject({
      action: 'channel-unknown',
    });
  });
});

function makeRecoveryDeps(overrides: Partial<ChannelRecoveryDeps> = {}) {
  const calls = { setChannel: [] as string[], cleared: 0 };
  const deps: ChannelRecoveryDeps = {
    getChannel: async () => 'dev',
    setChannel: async target => {
      calls.setChannel.push(target);
    },
    readMarker: () => marker(),
    clearMarker: () => {
      calls.cleared++;
    },
    isAlive: () => false,
    now: () => T0 + 60_000,
    ...overrides,
  };
  return { deps, calls };
}

describe('recoverStrandedChannel — the preflight repair pass', () => {
  it('flips a stranded box back to :latest and drops the marker', async () => {
    const { deps, calls } = makeRecoveryDeps();
    const result = await recoverStrandedChannel(deps);
    expect(calls.setChannel).toEqual(['latest']);
    expect(calls.cleared).toBe(1);
    expect(result).toMatchObject({ action: 'repair', repaired: true, error: null, markerSha: SHORT });
    expect(recoverExitCode(result)).toBe(0);
  });

  it('does NOT flip while a live harness owns the flip', async () => {
    const { deps, calls } = makeRecoveryDeps({ isAlive: () => true });
    const result = await recoverStrandedChannel(deps);
    expect(calls.setChannel).toEqual([]);
    expect(calls.cleared).toBe(0);
    expect(result.action).toBe('harness-in-flight');
    expect(recoverExitCode(result)).toBe(0);
  });

  it('does NOT flip when the box did not answer get_channel', async () => {
    const { deps, calls } = makeRecoveryDeps({ getChannel: async () => null, readMarker: () => null });
    const result = await recoverStrandedChannel(deps);
    expect(calls.setChannel).toEqual([]);
    expect(recoverExitCode(result)).toBe(2);
  });

  it('reports a FAILED repair as the same hard-alert exit 5 as a failed flip-back', async () => {
    const { deps } = makeRecoveryDeps({ setChannel: boom('mcp set_channel failed (HTTP 502)') });
    const result = await recoverStrandedChannel(deps);
    expect(result).toMatchObject({ action: 'repair', repaired: false });
    expect(result.error).toContain('502');
    expect(recoverExitCode(result)).toBe(5);
  });

  it('KEEPS the marker when the repair failed — it is the only record of who stranded the box', async () => {
    const { deps, calls } = makeRecoveryDeps({ setChannel: boom('boom') });
    await recoverStrandedChannel(deps);
    expect(calls.cleared).toBe(0);
  });

  it('clears a marker left behind on a box that is already back on :latest', async () => {
    const { deps, calls } = makeRecoveryDeps({ getChannel: async () => 'latest' });
    const result = await recoverStrandedChannel(deps);
    expect(calls.setChannel).toEqual([]);
    expect(calls.cleared).toBe(1);
    expect(result.action).toBe('not-on-dev');
  });
});

describe('runDevVerify writes the marker before the flip and drops it only on a confirmed flip-back', () => {
  function markerDeps(overrides: Partial<DevVerifyRunDeps> = {}) {
    const events: string[] = [];
    const base = makeRunDeps({
      setChannel: async () => {
        events.push('flip');
      },
      ...overrides,
    });
    const deps: DevVerifyRunDeps = {
      ...base.deps,
      markFlipped: () => events.push('mark'),
      clearMark: () => events.push('clear'),
    };
    return { deps, events, calls: base.calls };
  }

  it('marks BEFORE the flip POST — a marker written after it misses the fatal window', async () => {
    const { deps, events } = markerDeps();
    await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(events.indexOf('mark')).toBeLessThan(events.indexOf('flip'));
    expect(events[events.length - 1]).toBe('clear');
  });

  it('marks even when the flip POST is refused — the POST may still have landed', async () => {
    const { deps, events } = markerDeps({ setChannel: boom('mcp set_channel failed (HTTP 502)') });
    await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(events).toContain('mark');
    expect(events).toContain('clear'); // the flip-back was confirmed, so the marker goes
  });

  it('KEEPS the marker when the flip-back failed — that is what --recover repairs', async () => {
    const stranded: FlipBackResult = {
      flippedBack: false,
      channel: 'dev',
      reissues: 5,
      polls: 60,
      detail: 'box still reports :dev after 900s',
    };
    const { deps, events } = markerDeps({ flipBack: async () => stranded });
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(devVerifyExitCode(outcome)).toBe(5);
    expect(events).toContain('mark');
    expect(events).not.toContain('clear');
  });

  it('never marks a run that never flipped (no :dev image on the registry)', async () => {
    const { deps, events } = markerDeps({ waitForDevPush: async () => NOT_PUSHED });
    await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(events).not.toContain('mark');
  });

  it('fails CLOSED when the marker cannot be written — no unrecoverable flip', async () => {
    const base = makeRunDeps();
    const deps: DevVerifyRunDeps = {
      ...base.deps,
      markFlipped: () => {
        throw new Error('EROFS: read-only file system');
      },
    };
    const outcome = await runDevVerify(SHORT, deps, RUN_OPTS);
    expect(outcome.failure).toMatchObject({ step: 'flip-to-dev' });
    expect(base.calls.setChannel).toBe(0); // the box was never flipped
  });
});

// ---------------------------------------------------------------------------
// Playbook guards (#2826): the two prose rules that back the marker are as
// load-bearing as the code, and prose is what an LLM skips (CLAUDE.md). Same
// shape as the credential guard in scripts/autoloop-box.test.ts.
// ---------------------------------------------------------------------------

describe('the playbooks carry the #2826 rules', () => {
  const skill = readFileSync('.claude/skills/autoloop-issues/SKILL.md', 'utf8');
  const boxVerify = readFileSync('.claude/skills/autoloop-issues/stages/box-verify.md', 'utf8');

  it('SKILL.md Step 0 probes the channel and repairs through the script', () => {
    const step0 = skill.slice(skill.indexOf('## Step 0'), skill.indexOf('## Step 1'));
    expect(step0).toMatch(/get_channel/);
    expect(step0).toMatch(/autoloop:dev-verify -- --recover/);
  });

  it('box-verify.md forbids a FULL verify from upgrading/restarting the service the agent runs in', () => {
    expect(boxVerify).toMatch(/claude-dev/);
    expect(boxVerify).toMatch(/#2826/);
    expect(boxVerify).toMatch(/[Nn]ever[\s\S]{0,80}(upgrade|restart|recreate)/);
  });

  it('both name the marker path, so a reader can find the state the recovery reads', () => {
    expect(`${skill}${boxVerify}`).toContain(DEV_VERIFY_MARKER_PATH);
  });
});
