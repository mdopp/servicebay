import { describe, it, expect } from 'vitest';
import { isContainerCurrentlyStable, restartCountIndicatesLoop, psLineIndicatesLoop } from './runDiagnose';

// The cumulative-RestartCount crash-loop signal is gated on this predicate so a
// container with a high LIFETIME restart count that has since been up for hours
// is not falsely flagged as "in a restart loop" (#crash-loop-cumulative — the
// real solaris-tts-bridge case: RestartCount=24 yet Up 44 hours, ExitCode 0).
describe('isContainerCurrentlyStable', () => {
  it('treats Up minutes/hours/days as stable (a high lifetime count there is historical)', () => {
    for (const s of ['Up 44 hours', 'Up 2 days', 'Up 5 minutes', 'Up About a minute', 'Up About an hour', 'Up 3 weeks']) {
      expect(isContainerCurrentlyStable(s)).toBe(true);
    }
  });

  it('treats freshly-up / restarting / exited as NOT stable (a real loop is always one of these)', () => {
    for (const s of ['Up 5 seconds', 'Up 29 seconds', 'Up Less than a second', 'Restarting (1) 3 seconds ago', 'Exited (0) 2 hours ago', 'Created']) {
      expect(isContainerCurrentlyStable(s)).toBe(false);
    }
  });

  it('is whitespace-tolerant', () => {
    expect(isContainerCurrentlyStable('  Up 44 hours  ')).toBe(true);
    expect(isContainerCurrentlyStable('Up 10 seconds ')).toBe(false);
  });
});

describe('restartCountIndicatesLoop', () => {
  const T = 3;
  it('does NOT flag a high cumulative count on a currently-stable container', () => {
    // The real solaris-tts-bridge: 24 restarts but Up 44h → historical, not a loop.
    expect(restartCountIndicatesLoop(24, 'Up 44 hours', T)).toBe(false);
    expect(restartCountIndicatesLoop(99, 'Up 5 minutes', T)).toBe(false);
  });
  it('flags a high count on a freshly-up / restarting container (a genuine loop)', () => {
    expect(restartCountIndicatesLoop(13801, 'Restarting (1) 2 seconds ago', T)).toBe(true);
    expect(restartCountIndicatesLoop(5, 'Up 4 seconds', T)).toBe(true);
  });
  it('ignores a count below the threshold regardless of status', () => {
    expect(restartCountIndicatesLoop(2, 'Restarting', T)).toBe(false);
    expect(restartCountIndicatesLoop(0, 'Up 2 seconds', T)).toBe(false);
  });
  it('never trips on a non-numeric / NaN count', () => {
    expect(restartCountIndicatesLoop(NaN, 'Restarting', T)).toBe(false);
  });
});

// psLineIndicatesLoop is the FULL per-container crash-loop verdict the crash_loop
// probe applies to each `podman ps` row — the composite decision path (restart-count
// first, then status heuristics gated on treatYoungAsLoop). Pinning it directly keeps
// the orchestrator's crash_loop branch from silently flipping (a boundary/inversion
// slip there masks a crash-looping service as green — memory: "don't mask failures").
describe('psLineIndicatesLoop', () => {
  const T = 3;
  const past = { treatYoungAsLoop: true, threshold: T }; // system past its boot/install grace
  const grace = { treatYoungAsLoop: false, threshold: T }; // still inside grace (fresh boot/install)

  describe('detects a genuine restart loop', () => {
    it('flags an explicit Restarting status regardless of grace or count', () => {
      expect(psLineIndicatesLoop('Restarting (1) 2 seconds ago', 0, past)).toBe(true);
      // Restarting fires even inside the grace window — it is unambiguous.
      expect(psLineIndicatesLoop('Restarting (1) 2 seconds ago', 0, grace)).toBe(true);
    });
    it('flags an Initialized (never-started) container', () => {
      expect(psLineIndicatesLoop('Initialized', 0, past)).toBe(true);
      expect(psLineIndicatesLoop('Initialized', 0, grace)).toBe(true);
    });
    it('flags a high cumulative restart count on a not-currently-stable container', () => {
      // Authelia #622 had 13801 restarts, freshly-up — fires even through the grace window.
      expect(psLineIndicatesLoop('Up 4 seconds', 13801, grace)).toBe(true);
      expect(psLineIndicatesLoop('Up 4 seconds', 3, past)).toBe(true);
    });
    it('flags a young Up container once past the boot/install grace window', () => {
      expect(psLineIndicatesLoop('Up 29 seconds', 0, past)).toBe(true);
      expect(psLineIndicatesLoop('Up Less than a second', 0, past)).toBe(true);
    });
  });

  describe('healthy / all-stable case', () => {
    it('does NOT flag a long-stable container with no restarts', () => {
      for (const s of ['Up 44 hours', 'Up 2 days', 'Up 5 minutes', 'Up About a minute', 'Up About an hour']) {
        expect(psLineIndicatesLoop(s, 0, past)).toBe(false);
      }
    });
  });

  describe('no false positive on a normal restart', () => {
    it('does NOT flag a high LIFETIME count on a container that is now long-stable', () => {
      // solaris-tts-bridge: RestartCount=24 yet Up 44h → historical, not an active loop.
      expect(psLineIndicatesLoop('Up 44 hours', 24, past)).toBe(false);
      expect(psLineIndicatesLoop('Up 5 minutes', 99, past)).toBe(false);
    });
    it('does NOT flag a below-threshold count on its own (sporadic OOM recovery)', () => {
      // 1-2 restarts on an otherwise-stable container is not a loop.
      expect(psLineIndicatesLoop('Up 10 minutes', 2, past)).toBe(false);
    });
    it('does NOT flag a young container while still inside the boot/install grace window', () => {
      // Right after boot/install every container is young — expected, not a loop.
      expect(psLineIndicatesLoop('Up 5 seconds', 0, grace)).toBe(false);
      expect(psLineIndicatesLoop('Up Less than a second', 0, grace)).toBe(false);
    });
    it('respects the 30s boundary once past grace (30s is not young enough to be a loop)', () => {
      expect(psLineIndicatesLoop('Up 30 seconds', 0, past)).toBe(false);
      expect(psLineIndicatesLoop('Up 29 seconds', 0, past)).toBe(true);
    });
  });
});
