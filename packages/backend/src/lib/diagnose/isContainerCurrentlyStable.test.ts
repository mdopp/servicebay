import { describe, it, expect } from 'vitest';
import { isContainerCurrentlyStable, restartCountIndicatesLoop } from './runDiagnose';

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
