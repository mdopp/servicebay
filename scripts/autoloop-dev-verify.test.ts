import { describe, it, expect } from 'vitest';
import {
  revisionMatchesSha,
  confirmFlipBack,
  confirmDevImage,
  parseDevVerifyArgs,
  parseRevisionOutput,
  DEV_IMAGE_TIMEOUT_SEC,
  FLIP_BACK_TIMEOUT_SEC,
  type DevImageDeps,
  type FlipBackDeps,
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

describe('parseRevisionOutput', () => {
  it('takes the last non-empty line of a podman inspect --format stdout', () => {
    expect(parseRevisionOutput(`warning: something\n${FULL}\n`)).toBe(FULL);
  });

  it("normalises Go template's <no value> (image carries no revision label) to empty", () => {
    expect(parseRevisionOutput('<no value>\n')).toBe('');
    expect(parseRevisionOutput('   \n')).toBe('');
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
