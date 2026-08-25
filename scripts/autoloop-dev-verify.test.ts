import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
  FLIP_BACK_TIMEOUT_SEC,
  type DevImageDeps,
  type DevImageResult,
  type DevVerifyOutcome,
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

const RUN_OPTS = { imageTimeout: DEV_IMAGE_TIMEOUT_SEC, flipBackTimeout: FLIP_BACK_TIMEOUT_SEC };

function makeRunDeps(overrides: Partial<DevVerifyRunDeps> = {}) {
  const calls = { flipBacks: 0, probes: 0, setChannel: 0 };
  const deps: DevVerifyRunDeps = {
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
      devImage: null,
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
      devImage: REACHED,
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
      devImage: REACHED,
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
