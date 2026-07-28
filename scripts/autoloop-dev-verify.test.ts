import { describe, it, expect } from 'vitest';
import { revisionMatchesSha, confirmFlipBack, FLIP_BACK_TIMEOUT_SEC, type FlipBackDeps } from './autoloop-dev-verify';

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
