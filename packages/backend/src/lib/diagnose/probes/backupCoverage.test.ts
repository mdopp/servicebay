import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock hoists above top-level const, so expose mutable state via a closure.
const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  history: [] as Array<{ success: boolean; completedAt: string; message: string }>,
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => state.config),
}));
vi.mock('@/lib/backup/service', () => ({
  getBackupHistory: vi.fn(async () => state.history),
}));

import {
  checkContentBackup,
  checkConfigBackup,
  CONFIG_ONLY_CAVEAT,
  formatAge,
  OVERDUE_FACTOR,
} from './backupCoverage';

const NOW = new Date('2026-08-25T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CONFIGURED = {
  enabled: true,
  schedule: 'daily' as const,
  time: '02:00',
  target: { type: 'local' as const, path: '/mnt/backup' },
  sources: [{ path: '/mnt/data' }],
};

beforeEach(() => {
  state.config = {};
  state.history = [];
});

describe('formatAge', () => {
  it('scales from minutes to days', () => {
    expect(formatAge(5 * 60_000)).toBe('5 minutes');
    expect(formatAge(60_000)).toBe('1 minute');
    expect(formatAge(3 * HOUR)).toBe('3 hours');
    expect(formatAge(400 * DAY)).toBe('400 days');
  });
});

describe('checkContentBackup — criterion 1: unconfigured is a named state', () => {
  it('reports not_configured (not an error, not silence) when config.backup is absent', async () => {
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('not_configured');
    // Named + surfaced: a warn is what makes the row visible at all. An `info`
    // here would render green, which is the exact bug #2615 is about.
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/has never been configured/);
    expect(r.hint).toMatch(/Settings → Backup/);
  });

  it('is not reported as an exception, the way the pre-#2443 crash surfaced', async () => {
    state.history = [{
      success: false,
      completedAt: '2026-07-19T17:57:36.030Z',
      message: "Cannot read properties of undefined (reading 'sources')",
    }];
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('not_configured');
    // The crash text may be quoted as history, but the probe's own framing is
    // the named state, not a stack-shaped error.
    expect(r.detail).toMatch(/never been configured/);
    expect(r.detail).toMatch(/2026-07-19/);
    expect(r.detail).toMatch(/nothing has run since/);
  });

  it('says so plainly when there is no history at all either', async () => {
    const r = await checkContentBackup(NOW);
    expect(r.detail).toMatch(/No run has ever been recorded/);
  });

  it('distinguishes a deliberate opt-out from never-configured', async () => {
    state.config = { backup: { ...CONFIGURED, enabled: false } };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('switched_off');
    // A decision on the record is allowed to be quiet.
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/recorded decision, not a fault/);
  });

  it('warns when it is enabled but covers no source directory', async () => {
    state.config = { backup: { ...CONFIGURED, sources: [] } };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('no_sources');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/does not protect any data/);
  });
});

describe('checkContentBackup — criterion 2: failed or overdue surfaces', () => {
  it('warns when it has never run', async () => {
    state.config = { backup: CONFIGURED };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('never_ran');
    expect(r.status).toBe('warn');
  });

  it('warns when the last run failed, and quotes the reason', async () => {
    state.config = {
      backup: { ...CONFIGURED, lastRun: ago(2 * HOUR), lastStatus: 'error', lastMessage: 'target is read-only' },
    };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('last_run_failed');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/target is read-only/);
    expect(r.detail).toMatch(/2 hours ago/);
  });

  it('warns when a daily backup is well past its own interval', async () => {
    state.config = { backup: { ...CONFIGURED, lastRun: ago(5 * DAY), lastStatus: 'success' } };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('overdue');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/5 days ago/);
  });

  it('does not cry overdue inside the grace factor', async () => {
    // 1.5 daily intervals — late, but not yet the OVERDUE_FACTOR threshold.
    state.config = { backup: { ...CONFIGURED, lastRun: ago(1.5 * DAY), lastStatus: 'success' } };
    expect(OVERDUE_FACTOR).toBe(2);
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('ok');
    expect(r.status).toBe('ok');
  });

  it('uses the schedule\'s own interval, not a fixed one', async () => {
    // 5 days is overdue for `daily`, comfortably fine for `monthly`.
    state.config = {
      backup: { ...CONFIGURED, schedule: 'monthly', lastRun: ago(5 * DAY), lastStatus: 'success' },
    };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('ok');
  });

  it('reports a healthy run with what it actually covers', async () => {
    state.config = { backup: { ...CONFIGURED, lastRun: ago(3 * HOUR), lastStatus: 'success' } };
    const r = await checkContentBackup(NOW);
    expect(r.state).toBe('ok');
    expect(r.detail).toMatch(/\/mnt\/data/);
  });
});

describe('checkConfigBackup — criterion 3: last nightly result is visible', () => {
  it('warns when no run has ever been recorded', async () => {
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('never_ran');
    expect(r.status).toBe('warn');
  });

  it('reports a healthy run denominator-first', async () => {
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'success', servicesOk: 11, servicesTotal: 11,
      },
    };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('ok');
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/11\/11 services/);
  });

  it('warns on a partial run and names it as partial, not success', async () => {
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'partial',
        servicesOk: 9, servicesTotal: 11, lastMessage: 'Not backed up: immich (no config on disk)',
      },
    };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('partial');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/9\/11 services/);
    expect(r.detail).toMatch(/immich/);
  });

  it('warns when the run failed outright', async () => {
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'error',
        servicesOk: 0, servicesTotal: 0, lastMessage: 'NAS unreachable',
      },
    };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('last_run_failed');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/NAS unreachable/);
  });

  it('warns when the nightly run is well past its own interval', async () => {
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(9 * DAY), lastStatus: 'success', servicesOk: 11, servicesTotal: 11,
      },
    };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('overdue');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/9 days ago/);
  });

  it('names 0/0 as "nothing to do" rather than a success', async () => {
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'success', servicesOk: 0, servicesTotal: 0,
      },
    };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('nothing_installed');
    expect(r.detail).toMatch(/0\/0 services/);
  });

  it('reports a deliberate opt-out quietly', async () => {
    state.config = { externalBackup: { enabled: false } };
    const r = await checkConfigBackup(NOW);
    expect(r.state).toBe('switched_off');
    expect(r.status).toBe('info');
  });
});

describe('criterion 4: the two mechanisms never collapse into one status', () => {
  it('carries the config-only caveat in EVERY config-backup state', async () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { enabled: false },
      { enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'success', servicesOk: 11, servicesTotal: 11 },
      { enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'success', servicesOk: 0, servicesTotal: 0 },
      { enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'partial', servicesOk: 9, servicesTotal: 11 },
      { enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'error', servicesOk: 0, servicesTotal: 3 },
      { enabled: true, lastRun: ago(9 * DAY), lastStatus: 'success', servicesOk: 11, servicesTotal: 11 },
    ];
    for (const externalBackup of cases) {
      state.config = { externalBackup };
      const r = await checkConfigBackup(NOW);
      expect(r.detail, JSON.stringify(externalBackup)).toContain(CONFIG_ONLY_CAVEAT);
    }
  });

  it('never claims content is covered — the caveat names the exclusion and the other row', () => {
    expect(CONFIG_ONLY_CAVEAT).toMatch(/per-service configuration only/i);
    expect(CONFIG_ONLY_CAVEAT).toMatch(/\/mnt\/data/);
    expect(CONFIG_ONLY_CAVEAT).toMatch(/Content backup/);
  });

  it('a green config backup + a never-configured content backup stay two different answers', async () => {
    // The reference box, exactly: 11/11 nightly config backups AND no content
    // backup at all. The green one must not be able to speak for the other.
    state.config = {
      externalBackup: {
        enabled: true, lastRun: ago(6 * HOUR), lastStatus: 'success', servicesOk: 11, servicesTotal: 11,
      },
    };
    const [content, config] = await Promise.all([checkContentBackup(NOW), checkConfigBackup(NOW)]);
    expect(config.status).toBe('ok');
    expect(content.status).toBe('warn');
    expect(content.state).toBe('not_configured');
    expect(config.detail).toContain(CONFIG_ONLY_CAVEAT);
  });
});
