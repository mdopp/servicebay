/**
 * #2591 — the backup-coverage signal must survive the WHOLE way to
 * `get_health_checks`, not merely exist as a probe function.
 *
 * The two halves were already covered *separately*: `backupCoverage.test.ts`
 * calls `checkContentBackup()` directly, and `healthTools.getChecks.test.ts`
 * hands `get_health_checks` a hand-written `diagnose:content_backup` row. Neither
 * touches the chain in between — probe status → `persistDiagnoseResults` (the
 * four-way `warn|info|ok|fail` collapsed onto the store's `ok|fail`) → the
 * on-disk result → `getDiagnoseChecksEnriched` → the tool's fold-in. Break any
 * link there and `get_health_checks` answers with a list that has no backup row
 * in it at all, which reads exactly like a healthy box.
 *
 * That is the failure #2591 is about, and it is the shape this repo keeps
 * producing: for over a year nothing anywhere said the content backup did not
 * exist, while every surface looked fine. So the assertion that matters is not
 * "the healthy box says ok" — it is **the broken box says fail**. The healthy
 * case is here only to prove the row is not stuck red, i.e. that the green is
 * earned rather than absent.
 *
 * The state driven below is the reference box's real one on 2026-08: no `backup`
 * key in the config at all (Backup Sync never configured), and one failed run
 * recorded in 2026-07 that nothing followed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { ToolServer } from '@/lib/mcp/tools/context';
import type { BackupRunResult } from '@/lib/backup/types';

/** The live box state the probes read. Swapped per test case. */
const box = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  history: [] as BackupRunResult[],
}));

vi.mock('@/lib/config', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getConfig: async () => box.config,
}));
vi.mock('@/lib/backup/service', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backup/service')>()),
  getBackupHistory: async () => box.history,
}));
// The attribution index reads the digital twin; a backup probe is box-wide, so
// an empty twin is the honest input and keeps the store layer out of this test.
vi.mock('@/lib/store/repository', () => ({ getServices: () => [], getContainers: () => [] }));
// `diagnoseChecks` imports the whole diagnose suite for its scheduler tick. This
// test exercises the *reader* half of that module, so keep the heavy graph out.
vi.mock('@/lib/diagnose/runDiagnose', () => ({ runDiagnose: vi.fn() }));
vi.mock('@/lib/health/runner', () => ({ CheckRunner: { runCheck: vi.fn() } }));

type ToolHandler = (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface HealthCheckRow {
  id: string;
  name?: string;
  status?: string;
  diagnose?: { status?: string; detail?: string; hint?: string };
}

let tmpDir: string;

/**
 * Drive the real chain: run both probes, persist them the way `runDiagnose`
 * does, then ask the real `get_health_checks` tool what the operator sees.
 */
async function backupRowsAsSeenByGetHealthChecks(now: Date): Promise<Record<string, HealthCheckRow>> {
  const {
    checkContentBackup,
    checkConfigBackup,
    CONTENT_BACKUP_PROBE_ID,
    CONTENT_BACKUP_PROBE_LABEL,
    CONFIG_BACKUP_PROBE_ID,
    CONFIG_BACKUP_PROBE_LABEL,
  } = await import('./backupCoverage');
  const { persistDiagnoseResults } = await import('@/lib/diagnose/persistDiagnoseResults');

  const content = await checkContentBackup(now);
  const config = await checkConfigBackup(now);
  persistDiagnoseResults([
    {
      id: CONTENT_BACKUP_PROBE_ID,
      label: CONTENT_BACKUP_PROBE_LABEL,
      status: content.status,
      detail: content.detail,
      hint: content.hint,
    },
    {
      id: CONFIG_BACKUP_PROBE_ID,
      label: CONFIG_BACKUP_PROBE_LABEL,
      status: config.status,
      detail: config.detail,
      hint: config.hint,
    },
  ]);

  const tools = new Map<string, ToolHandler>();
  const stubServer: ToolServer = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      tools.set(name, handler);
      return undefined;
    },
  };
  const { registerHealthTools } = await import('@/lib/mcp/tools/healthTools');
  registerHealthTools({ server: stubServer });
  const handler = tools.get('get_health_checks');
  if (!handler) throw new Error('get_health_checks was not registered');
  const rows = JSON.parse((await handler()).content[0].text) as HealthCheckRow[];
  return Object.fromEntries(rows.map(row => [row.id, row]));
}

describe('backup coverage reaches get_health_checks (#2591)', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-coverage-e2e-'));
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    box.config = {};
    box.history = [];
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports BOTH backup rows as failing on the box state this issue was filed for', async () => {
    // No `backup` key at all, and an externalBackup that has never recorded a
    // run — the two silences that added up to "every service is unprotected".
    box.config = { externalBackup: { enabled: true } };
    box.history = [
      {
        success: false,
        startedAt: '2026-07-19T17:57:36.029Z',
        completedAt: '2026-07-19T17:57:36.030Z',
        duration: 0,
        message: "Cannot read properties of undefined (reading 'sources')",
      },
    ];

    const rows = await backupRowsAsSeenByGetHealthChecks(new Date('2026-08-23T12:00:00Z'));

    // Denominator first: the rows must be PRESENT. An absent row is the bug.
    expect(Object.keys(rows)).toEqual(
      expect.arrayContaining(['diagnose:content_backup', 'diagnose:config_backup']),
    );

    const content = rows['diagnose:content_backup'];
    expect(content.status).toBe('fail');
    expect(content.name).toBe('Self-diagnose: Content backup (Backup Sync)');
    expect(content.diagnose?.status).toBe('warn');
    expect(content.diagnose?.detail).toContain('never been configured');
    // The one failed run is not swallowed — it is carried into the operator text.
    expect(content.diagnose?.detail).toContain('2026-07-19');

    const config = rows['diagnose:config_backup'];
    expect(config.status).toBe('fail');
    expect(config.diagnose?.status).toBe('warn');
    expect(config.diagnose?.detail).toContain('no recorded run');
  });

  it('reports the content row as failing when a configured Backup Sync goes stale', async () => {
    box.config = {
      backup: {
        enabled: true,
        schedule: 'daily',
        time: '02:00',
        target: { type: 'local', path: '/mnt/backup' },
        sources: [{ path: '/mnt/data' }],
        lastRun: '2026-08-10T02:00:00Z',
        lastStatus: 'success',
      },
      externalBackup: {
        enabled: true,
        lastRun: '2026-08-23T03:30:00Z',
        lastStatus: 'success',
        servicesOk: 11,
        servicesTotal: 11,
      },
    };

    const rows = await backupRowsAsSeenByGetHealthChecks(new Date('2026-08-23T12:00:00Z'));

    // 13 days on a daily schedule — well past 2x its own interval.
    expect(rows['diagnose:content_backup'].status).toBe('fail');
    expect(rows['diagnose:content_backup'].diagnose?.detail).toContain('daily');
    // The healthy nightly push must NOT be dragged down with it: two rows, two
    // verdicts, so a green config backup can never speak for the content one.
    expect(rows['diagnose:config_backup'].status).toBe('ok');
  });

  it('reports the config row as failing when the nightly NAS run goes stale', async () => {
    box.config = {
      backup: {
        enabled: true,
        schedule: 'daily',
        time: '02:00',
        target: { type: 'local', path: '/mnt/backup' },
        sources: [{ path: '/mnt/data' }],
        lastRun: '2026-08-23T02:00:00Z',
        lastStatus: 'success',
      },
      externalBackup: {
        enabled: true,
        lastRun: '2026-08-18T03:30:00Z',
        lastStatus: 'success',
        servicesOk: 11,
        servicesTotal: 11,
      },
    };

    const rows = await backupRowsAsSeenByGetHealthChecks(new Date('2026-08-23T12:00:00Z'));

    expect(rows['diagnose:content_backup'].status).toBe('ok');
    expect(rows['diagnose:config_backup'].status).toBe('fail');
    expect(rows['diagnose:config_backup'].diagnose?.detail).toContain('more than');
  });

  it('shows both rows green on a box where both mechanisms actually ran', async () => {
    box.config = {
      backup: {
        enabled: true,
        schedule: 'daily',
        time: '02:00',
        target: { type: 'local', path: '/mnt/backup' },
        sources: [{ path: '/mnt/data' }],
        lastRun: '2026-08-23T02:00:00Z',
        lastStatus: 'success',
      },
      externalBackup: {
        enabled: true,
        lastRun: '2026-08-23T03:30:00Z',
        lastStatus: 'success',
        servicesOk: 11,
        servicesTotal: 11,
      },
    };

    const rows = await backupRowsAsSeenByGetHealthChecks(new Date('2026-08-23T12:00:00Z'));

    expect(rows['diagnose:content_backup'].status).toBe('ok');
    expect(rows['diagnose:config_backup'].status).toBe('ok');
    // Green here still says what it does NOT cover — the caveat is unconditional.
    expect(rows['diagnose:config_backup'].diagnose?.detail).toContain('/mnt/data');
  });
});
