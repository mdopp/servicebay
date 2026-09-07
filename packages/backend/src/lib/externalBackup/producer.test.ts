import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas, mockGetConfig, mockSendCommand, mockExecutor, mockGetExecutor } = vi.hoisted(() => ({
  mockNas: {
    nasUpload: vi.fn(),
    nasDownload: vi.fn(),
    nasList: vi.fn(),
    nasRemove: vi.fn(),
  },
  mockGetConfig: vi.fn(),
  mockSendCommand: vi.fn(),
  mockExecutor: {
    exec: vi.fn(),
    execArgv: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    exists: vi.fn(),
  },
  mockGetExecutor: vi.fn(),
}));

// Keep the REAL connection-error classifier: `summariseBackupRun` and the
// `config_backup` probe both key off it, so a hand-rolled stub here would let
// the grouping drift from what the transport actually reports (#2876).
vi.mock('./nasClient', async () => ({
  ...mockNas,
  withNasSession: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  isConnectionLevelError: (await vi.importActual<typeof import('./nasClient')>('./nasClient'))
    .isConnectionLevelError,
}));
vi.mock('../config', () => ({ getConfig: () => mockGetConfig(), updateConfig: vi.fn(async () => ({})) }));
vi.mock('../agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(async () => ({ sendCommand: mockSendCommand })) },
}));
vi.mock('../executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));

import {
  stageServiceBackup,
  buildServiceBackupTar,
  backupServiceToNas,
  stageUploadedServiceTar,
  resolveServiceDataDir,
  runBackupCollector,
  listServiceBackups,
  fetchServiceBackup,
  getNextExternalBackupDelayMs,
  scheduleExternalNasBackup,
  getNasBackupSchedule,
  deleteServiceBackup,
  NAS_BACKUP_DIR,
  DEFAULT_BACKUP_RETENTION,
  latestServiceBackupName,
  summariseBackupRun,
} from './producer';
import { type ServiceBackupManifest } from '@servicebay/backup-manifest';
import { builtinManifest } from '../../../../../tests/fixtures/builtinBackupManifests';
import { logger } from '../logger';

/** Match a dated slot tar `<service>-YYYYMMDD-HHMM.tar` (#1865). */
const datedTarRe = (service: string) => new RegExp(`/${service}-\\d{8}-\\d{4}\\.tar$`);

let tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeFile(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({ templateSettings: {} });
  mockNas.nasUpload.mockResolvedValue(undefined);
  // #1865 — writeServiceBackupToNas prunes after each write (lists then removes);
  // default to an empty NAS so the per-write tests see no prior snapshots.
  mockNas.nasList.mockResolvedValue([]);
  mockNas.nasRemove.mockResolvedValue(undefined);
  mockGetExecutor.mockReturnValue(mockExecutor);
});

afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe('stageServiceBackup', () => {
  it('stages included files, skips excluded ones, and recurses into included dirs', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'config.yaml', 'model: x');
    await writeFile(src, '.storage/lovelace', '{"ui":true}');
    await writeFile(src, '.storage/lovelace_dashboards', '{}');
    await writeFile(src, 'home-assistant_v2.db', 'BINARYDB');
    await writeFile(src, 'logs/today.log', 'noise');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['config.yaml', '.storage', 'missing.yaml'],
      exclude: ['home-assistant_v2.db', 'logs'],
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    expect(staged).toEqual(['.storage/lovelace', '.storage/lovelace_dashboards', 'config.yaml']);
    expect(await fs.readFile(path.join(staging, 'config.yaml'), 'utf8')).toBe('model: x');
    // Excluded + missing files never reach the staging dir.
    await expect(fs.access(path.join(staging, 'home-assistant_v2.db'))).rejects.toThrow();
    await expect(fs.access(path.join(staging, 'logs'))).rejects.toThrow();
  });

  it('expands a trailing-* leaf glob include to the matching files (#1595/#1596)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // HA dashboards (lovelace.<url_path>) + HACS data (hacs.*) + the bare
    // sidebar list, plus a sibling that must NOT match the lovelace glob.
    await writeFile(src, '.storage/lovelace', '{"ui":true}');
    await writeFile(src, '.storage/lovelace.lovelace', '{"dash":"main"}');
    await writeFile(src, '.storage/lovelace.map', '{"dash":"map"}');
    await writeFile(src, '.storage/lovelace_dashboards', '{"list":true}');
    await writeFile(src, '.storage/hacs.repositories', '{"repos":[]}');
    await writeFile(src, '.storage/hacs.data', '{"data":1}');
    await writeFile(src, '.storage/core.config_entries', '{"entries":[]}');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/lovelace*', '.storage/hacs*'],
      exclude: [],
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    // Every lovelace dashboard (including the bare name + the sidebar list) and
    // every hacs.* file is staged; the unrelated core.config_entries is not.
    expect(staged).toEqual([
      '.storage/hacs.data',
      '.storage/hacs.repositories',
      '.storage/lovelace',
      '.storage/lovelace.lovelace',
      '.storage/lovelace.map',
      '.storage/lovelace_dashboards',
    ]);
    expect(await fs.readFile(path.join(staging, '.storage/lovelace.map'), 'utf8')).toBe('{"dash":"map"}');
  });

  it('a glob include matching nothing stages no files (no literal-* file created)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, '.storage/core.config_entries', '{}');
    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/lovelace*'],
      exclude: [],
    };
    expect(await stageServiceBackup(src, manifest, staging)).toEqual([]);
  });

  it('stages an included directory (custom_components/) recursively (#1596)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'custom_components/meross_lan/__init__.py', 'CODE');
    await writeFile(src, 'custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['custom_components'],
      exclude: [],
    };
    const staged = await stageServiceBackup(src, manifest, staging);
    expect(staged).toEqual([
      'custom_components/meross_lan/__init__.py',
      'custom_components/meross_lan/manifest.json',
    ]);
  });

  it('applies strip rules to the targeted file only', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'users_database.yml', 'users:\n  a:\n    password: $argon2$secret\n    email: a@x\n');
    await writeFile(src, 'other.yml', 'password: keepme\n');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['users_database.yml', 'other.yml'],
      exclude: [],
      strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
    };
    await stageServiceBackup(src, manifest, staging);

    const stripped = await fs.readFile(path.join(staging, 'users_database.yml'), 'utf8');
    expect(stripped).not.toContain('secret');
    expect(stripped).toContain('a@x');
    // Non-targeted file is copied verbatim — the strip rule must not bleed.
    expect(await fs.readFile(path.join(staging, 'other.yml'), 'utf8')).toBe('password: keepme\n');
  });

  it('applies the HA config-entries add-on transform through staging (#1595)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(
      src,
      '.storage/core.config_entries',
      JSON.stringify({
        data: {
          entries: [
            { domain: 'zwave_js', data: { use_addon: true, integration_created_addon: true, url: 'ws://core-zwave-js:3000' } },
          ],
        },
      }),
    );

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['.storage/core.config_entries'],
      exclude: [],
      transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
    };
    await stageServiceBackup(src, manifest, staging);

    const staged = JSON.parse(
      await fs.readFile(path.join(staging, '.storage/core.config_entries'), 'utf8'),
    ) as { data: { entries: { data: Record<string, unknown> }[] } };
    expect(staged.data.entries[0].data.use_addon).toBe(false);
    expect(staged.data.entries[0].data.url).toBe('ws://localhost:3001');
  });

  it('stages a collector snapshot file under its canonical tarball name via renames (#1528)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // The collector left a consistent snapshot beside the live DB.
    await writeFile(src, 'data/database.sqlite.sb-backup', 'CONSISTENT-SNAPSHOT');
    await writeFile(src, 'data/database.sqlite', 'LIVE-WAL-TORN');

    const manifest: ServiceBackupManifest = {
      service: 'nginx',
      include: ['data/database.sqlite.sb-backup'],
      exclude: [],
      renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
    };
    const staged = await stageServiceBackup(src, manifest, staging);

    // Tarball carries the snapshot bytes under the canonical name.
    expect(staged).toEqual(['data/database.sqlite']);
    expect(await fs.readFile(path.join(staging, 'data/database.sqlite'), 'utf8')).toBe('CONSISTENT-SNAPSHOT');
    // The torn live file never reaches the tarball.
    await expect(fs.access(path.join(staging, 'data/database.sqlite.sb-backup'))).rejects.toThrow();
  });
});

describe('runBackupCollector (NPM in-container sqlite snapshot, #1528)', () => {
  const npm = builtinManifest('nginx');

  it('returns the manifest unchanged for a service with no collector', async () => {
    const ha = builtinManifest('home-assistant');
    expect((await runBackupCollector(ha, 'Local')).manifest).toBe(ha);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it('snapshots in-container and remaps the db include to the snapshot path', async () => {
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager docker.io/jc21/nginx-proxy-manager', code: 0 })
      .mockResolvedValueOnce({ stdout: 'ok', code: 0 });

    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out.include).toContain('data/database.sqlite.sb-backup');
    expect(out.include).not.toContain('data/database.sqlite');
    expect(out.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
    // certs are untouched by the remap.
    expect(out.include).toContain('letsencrypt');
    // `sqlite3 .backup` is torn-free, so the meta must NOT be flagged.
    expect(consistent).toBe(true);
  });

  it('falls back to the original manifest (live file) when the container is missing', async () => {
    mockSendCommand.mockResolvedValueOnce({ stdout: '', code: 0 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    expect(out.include).toContain('data/database.sqlite');
    expect(consistent).toBe(false);
  });

  it('falls back when the in-container snapshot command fails', async () => {
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'sqlite3: not found', code: 1 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    expect(consistent).toBe(false);
  });

  it('with no sqlite3 in the image, takes a LIVE copy INSIDE the container and marks it inconsistent (#2877)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // No sqlite3 → the script `cat`s the DB container-side into the .sb-backup
    // sidecar and prints `live`. The old behaviour left the manifest pointing at
    // the live HOST file, which is root-owned 0600 → EACCES in the worker every
    // single run, so NPM's proxy-host/cert DB was never on the NAS.
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'live', stderr: '', code: 0 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).not.toBe(npm);
    expect(out.include).toContain('data/database.sqlite.sb-backup');
    expect(out.include).not.toContain('data/database.sqlite');
    expect(out.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
    // A live copy is not torn-free — the meta must say so.
    expect(consistent).toBe(false);
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toMatch(/no sqlite3/i);
    expect(msg).toMatch(/LIVE/);
    warn.mockRestore();
  });

  it('the snapshot script never falls back to a HOST-side copy of the root-owned live DB (#2877)', async () => {
    // The whole point: no sqlite3 must NOT mean "let the host copy the file".
    // Both branches of the script write the .sb-backup sidecar from inside the
    // container and chmod it so the (differently-uid'd) worker can read it back.
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'live', stderr: '', code: 0 });
    await runBackupCollector(npm, 'Local');
    const command = (mockSendCommand.mock.calls[1][1] as { command: string }).command;
    const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) \|/.exec(command)![1], 'base64').toString();
    expect(script).toContain('cat "$DB" > "$DB.sb-snap"');
    expect(script).toContain('chmod 0644 "$DB.sb-backup"');
    // The sentinel the old code emitted (and gave up on) is gone.
    expect(script).not.toContain('no-sqlite3');
  });

  it('surfaces the container stderr (not "(unknown)") when the snapshot errors (#1894)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'sh: 1: sqlite3: Permission denied', code: 1 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toContain('Permission denied'); // the REAL stderr is logged
    expect(msg).not.toMatch(/\(unknown\)/);
    expect(consistent).toBe(false);
    warn.mockRestore();
  });

  it('remaps the include to the snapshot even when the live DB is absent (nodb sentinel, code 0)', async () => {
    // The script prints `nodb` (exit 0) when /data/database.sqlite doesn't exist.
    // `nodb` is NOT a failure — it must fall through to the remap, not the
    // live-file fallback. The (never-created) .sb-backup is then a no-op at
    // staging (stageServiceBackup skips a missing include), so the remap is safe.
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'nodb', stderr: '', code: 0 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    // Regression guard: `nodb` must not be swallowed into the live-file fallback.
    expect(out).not.toBe(npm);
    expect(out.include).toContain('data/database.sqlite.sb-backup');
    expect(out.include).not.toContain('data/database.sqlite');
    expect(out.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
    // Nothing to snapshot is not an inconsistent snapshot.
    expect(consistent).toBe(true);
  });

  it('drives the snapshot exec against the container name discovered by the ps/awk probe', async () => {
    // The awk probe returns "<name> <image>"; the collector must parse the FIRST
    // token as the container and target THAT name in the podman-exec snapshot.
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager  docker.io/jc21/nginx-proxy-manager', code: 0 })
      .mockResolvedValueOnce({ stdout: 'ok', code: 0 });
    await runBackupCollector(npm, 'Local');
    expect(mockSendCommand).toHaveBeenCalledTimes(2);
    const [op, args] = mockSendCommand.mock.calls[1];
    expect(op).toBe('exec');
    // The snapshot script is base64-piped into `podman exec -i <container> sh -`.
    expect((args as { command: string }).command).toContain('podman exec -i npm_proxy-manager sh -');
    // …and it must NOT leak the image token into the container name.
    expect((args as { command: string }).command).not.toContain('docker.io/jc21');
  });

  it('falls back to the live file on an unrecognized snapshot output even at exit 0', async () => {
    // A zero exit code with neither ok/nodb/no-sqlite3 is still a failure — the
    // snapshot did not complete, so we must degrade to the live file, never
    // remap to a snapshot that isn't there.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockResolvedValueOnce({ stdout: 'partial garbage', stderr: '', code: 0 });
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    expect(out.include).toContain('data/database.sqlite');
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toMatch(/snapshot failed/i);
    expect(consistent).toBe(false);
    warn.mockRestore();
  });

  it('does NOT turn a rejecting sendCommand into a silent green — degrades to the live file and logs (feedback_agent_sendcommand_rejects)', async () => {
    // agent.sendCommand REJECTS on an error reply (write_file EACCES etc.); it does
    // not resolve with {error}. The collector's catch must degrade honestly to the
    // live file AND log the real reason — never swallow the throw into a snapshot
    // that was never taken. Regression: an uncaught throw or a false-green remap.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockSendCommand
      .mockResolvedValueOnce({ stdout: 'npm_proxy-manager img', code: 0 })
      .mockRejectedValueOnce(new Error('agent exec EACCES'));
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm); // live file, not a phantom snapshot remap
    expect(out.include).toContain('data/database.sqlite');
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toContain('agent exec EACCES'); // the real error is surfaced
    expect(consistent).toBe(false);
    warn.mockRestore();
  });

  it('rejecting ensureAgent (node unreachable) degrades to the live file, not a crash', async () => {
    // The FIRST await (ensureAgent) can also reject if the node is unreachable.
    // That throw must land in the same honest-degrade catch, not propagate and
    // fail the whole backup run.
    const { agentManager } = await import('../agent/manager');
    const spy = vi
      .spyOn(agentManager, 'ensureAgent')
      .mockRejectedValueOnce(new Error('node offline'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { manifest: out, consistent } = await runBackupCollector(npm, 'Local');
    expect(out).toBe(npm);
    expect(mockSendCommand).not.toHaveBeenCalled();
    const msg = warn.mock.calls.map(c => String(c[1])).join('\n');
    expect(msg).toContain('node offline');
    expect(consistent).toBe(false);
    warn.mockRestore();
    spy.mockRestore();
  });
});

describe('runBackupCollector — pg-dump in the service\'s own Postgres container (#2864)', () => {
  const DATA_DIR = '/mnt/data/stacks';
  const HOST_DUMP = `${DATA_DIR}/paperless/paperless.dump.sb-dump`;

  const pgManifest = (over: Partial<ServiceBackupManifest> = {}): ServiceBackupManifest => ({
    service: 'paperless',
    include: ['media'],
    exclude: [],
    collector: { kind: 'pg-dump', container: 'paperless-db', user: 'paperless', database: 'paperless' },
    ...over,
  });

  type ExecReply = { stdout?: string; stderr?: string; code?: number };

  /** Answer each `safe_exec` by what it actually runs, so a test asserts on the
   *  argv rather than on a fragile call-order chain. */
  function mockPgAgent(over: { ps?: ExecReply; dump?: ExecReply; cp?: ExecReply } = {}): void {
    mockSendCommand.mockImplementation(async (_op: string, args: { argv?: string[] }) => {
      const argv = args.argv ?? [];
      const ok = { stdout: '', stderr: '', code: 0 };
      if (argv[0] === 'podman' && argv[1] === 'ps') return { ...ok, stdout: 'paperless-db\n', ...over.ps };
      if (argv.includes('pg_dump')) return { ...ok, ...over.dump };
      if (argv[0] === 'podman' && argv[1] === 'cp') return { ...ok, ...over.cp };
      return ok;
    });
  }

  const argvOf = (i: number): string[] =>
    (mockSendCommand.mock.calls[i][1] as { argv: string[] }).argv;
  const allArgv = (): string[][] =>
    mockSendCommand.mock.calls.map(c => (c[1] as { argv?: string[] }).argv ?? []);

  beforeEach(() => {
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR } });
  });

  it('builds a structured pg_dump argv — no shell string, no credential on the command line', async () => {
    mockPgAgent();
    await runBackupCollector(pgManifest(), 'Local');

    // Every step goes through the agent's argv path (`safe_exec`); a shell
    // string would re-parse a foreign template's container/user/db names.
    expect(mockSendCommand.mock.calls.every(c => c[0] === 'safe_exec')).toBe(true);
    const dumpArgv = allArgv().find(a => a.includes('pg_dump'))!;
    expect(dumpArgv).toEqual([
      'podman', 'exec', 'paperless-db',
      'pg_dump',
      '--username', 'paperless',
      '--dbname', 'paperless',
      '--format=custom',
      '--file', '/tmp/sb-paperless.sb-dump',
    ]);
    // pg_dump authenticates over the container's local socket — nothing that
    // looks like a password may ride the argv or the env of the exec.
    expect(dumpArgv.join(' ')).not.toMatch(/password|PGPASSWORD/i);
  });

  it('deletes the previous run\'s dump BEFORE dumping, then copies the new one out', async () => {
    mockPgAgent();
    const { manifest: out } = await runBackupCollector(pgManifest(), 'Local');

    // A stale dump must never be shipped as if it were today's — so the delete
    // is the FIRST thing that happens, before anything can fail.
    expect(argvOf(0)).toEqual(['rm', '-f', HOST_DUMP]);
    expect(allArgv()).toContainEqual([
      'podman', 'ps', '--filter', 'name=paperless-db', '--format', '{{.Names}}',
    ]);
    expect(allArgv()).toContainEqual([
      'podman', 'cp', 'paperless-db:/tmp/sb-paperless.sb-dump', HOST_DUMP,
    ]);
    // The container-side scratch copy is cleaned up.
    expect(allArgv()).toContainEqual(['podman', 'exec', 'paperless-db', 'rm', '-f', '/tmp/sb-paperless.sb-dump']);
    expect(out.renames).toEqual({ 'paperless.dump.sb-dump': 'paperless.dump' });
  });

  it('excludes pgdata/ even when the manifest declares it as an include', async () => {
    mockPgAgent();
    const { manifest: out } = await runBackupCollector(pgManifest({ include: ['media', 'pgdata'] }), 'Local');
    expect(out.exclude).toContain('pgdata');
    expect(out.include).toContain('paperless.dump.sb-dump');
  });

  it('never stages the raw cluster dir through the staging path', async () => {
    // End-to-end over the real staging: the collector-remapped manifest must
    // leave pgdata/ on disk and carry the dump under its canonical name.
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'media/doc.pdf', 'PDF');
    await writeFile(src, 'pgdata/base/1/2345', 'TORN-CLUSTER-PAGE');
    await writeFile(src, 'paperless.dump.sb-dump', 'PGDUMP-CUSTOM');

    mockPgAgent();
    const { manifest: remapped } = await runBackupCollector(pgManifest({ include: ['media', 'pgdata'] }), 'Local');
    const staged = await stageServiceBackup(src, remapped, staging);

    expect(staged).toEqual(['media/doc.pdf', 'paperless.dump']);
    expect(await fs.readFile(path.join(staging, 'paperless.dump'), 'utf8')).toBe('PGDUMP-CUSTOM');
    await expect(fs.access(path.join(staging, 'pgdata'))).rejects.toThrow();
  });

  it('reports the failure and stages NO dump when pg_dump fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockPgAgent({ dump: { code: 1, stderr: 'pg_dump: error: connection to server failed' } });

    const manifest = pgManifest();
    const { manifest: out } = await runBackupCollector(manifest, 'Local');

    // No remap: nothing claims a dump exists. The stale dump was already
    // removed, so the worker finds none and fails the service loudly rather
    // than shipping a tarball with no database in it.
    expect(out).toBe(manifest);
    expect(allArgv().some(a => a[1] === 'cp')).toBe(false);
    expect(warn.mock.calls.map(c => String(c[1])).join('\n')).toContain('connection to server failed');
    warn.mockRestore();
  });

  it('reports the failure when the Postgres container is not running', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockPgAgent({ ps: { stdout: '' } });
    const manifest = pgManifest();
    expect((await runBackupCollector(manifest, 'Local')).manifest).toBe(manifest);
    expect(allArgv().some(a => a.includes('pg_dump'))).toBe(false);
    expect(warn.mock.calls.map(c => String(c[1])).join('\n')).toMatch(/is not running/);
    warn.mockRestore();
  });

  it('does not match a container whose name merely CONTAINS the declared one', async () => {
    // `podman ps --filter name=` is a substring/regex match; the collector must
    // dump the declared container, not `paperless-db-backup-test`.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockPgAgent({ ps: { stdout: 'paperless-db-restore-test\n' } });
    const manifest = pgManifest();
    expect((await runBackupCollector(manifest, 'Local')).manifest).toBe(manifest);
    expect(allArgv().some(a => a.includes('pg_dump'))).toBe(false);
    warn.mockRestore();
  });

  it('reports the failure when the dump cannot be copied out of the container', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockPgAgent({ cp: { code: 1, stderr: 'no such file' } });
    const manifest = pgManifest();
    expect((await runBackupCollector(manifest, 'Local')).manifest).toBe(manifest);
    expect(warn.mock.calls.map(c => String(c[1])).join('\n')).toContain('no such file');
    warn.mockRestore();
  });

  it('refuses a misconfigured collector before it execs anything', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockPgAgent();
    const manifest = pgManifest({
      collector: { kind: 'pg-dump', container: 'paperless-db', user: '', database: 'paperless' },
    });
    expect((await runBackupCollector(manifest, 'Local')).manifest).toBe(manifest);
    expect(mockSendCommand).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(c => String(c[1])).join('\n')).toMatch(/misconfigured/);
    warn.mockRestore();
  });

  it('degrades honestly when the agent rejects (feedback_agent_sendcommand_rejects)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockSendCommand.mockRejectedValue(new Error('agent exec EACCES'));
    const manifest = pgManifest();
    expect((await runBackupCollector(manifest, 'Local')).manifest).toBe(manifest);
    expect(warn.mock.calls.map(c => String(c[1])).join('\n')).toContain('agent exec EACCES');
    warn.mockRestore();
  });
});

describe('buildServiceBackupTar', () => {
  it('produces a tar containing the staged + stripped files', async () => {
    const src = await mkTmp();
    await writeFile(src, 'config.yaml', 'a: 1');
    await writeFile(src, 'users_database.yml', 'users:\n  a:\n    password: SEKRIT\n');
    await writeFile(src, 'cache/big.bin', 'junk');

    const manifest: ServiceBackupManifest = {
      service: 'demo',
      include: ['config.yaml', 'users_database.yml'],
      exclude: ['cache'],
      strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
    };
    const tar = await buildServiceBackupTar(src, manifest);
    expect(tar.length).toBeGreaterThan(0);

    const out = await mkTmp();
    const tarFile = path.join(out, 'b.tar');
    await fs.writeFile(tarFile, tar);
    await execFileAsync('tar', ['-xf', tarFile, '-C', out]);

    expect(await fs.readFile(path.join(out, 'config.yaml'), 'utf8')).toBe('a: 1');
    expect(await fs.readFile(path.join(out, 'users_database.yml'), 'utf8')).not.toContain('SEKRIT');
    await expect(fs.access(path.join(out, 'cache'))).rejects.toThrow();
  });

  it('throws when no config files match', async () => {
    const src = await mkTmp();
    const manifest: ServiceBackupManifest = { service: 'empty', include: ['nope.yaml'], exclude: [] };
    await expect(buildServiceBackupTar(src, manifest)).rejects.toThrow(/No config files/);
  });
});

describe('resolveServiceDataDir', () => {
  it('joins the configured DATA_DIR with the service name', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: { DATA_DIR: '/srv/stacks' } });
    expect(await resolveServiceDataDir('adguard')).toBe('/srv/stacks/adguard');
  });

  it('falls back to /mnt/data/stacks when DATA_DIR is unset', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {} });
    expect(await resolveServiceDataDir('adguard')).toBe('/mnt/data/stacks/adguard');
  });

  it('refuses to invent a DATA_DIR path for a volume-held manifest (#2596)', async () => {
    // syncthing's config is in the podman volume `file-share-syncthing-config`.
    // Returning `<DATA_DIR>/syncthing` would let the restore/wipe callers write
    // into a directory the service never reads — and report success.
    // The syncthing store is DECLARED by file-share (#2858), so it resolves
    // only when that template is installed — same gate `gateOn` expressed.
    mockGetConfig.mockResolvedValue({
      templateSettings: { DATA_DIR: '/srv/stacks' },
      installedTemplates: { 'file-share': { schemaVersion: 1, installedAt: '2026-01-01T00:00:00.000Z' } },
    });
    await expect(resolveServiceDataDir('syncthing')).rejects.toThrow(/podman volume "file-share-syncthing-config"/);
  });
});

// The box backup (no serviceDataDir) now routes the HEAVY walk/copy/tar through
// the resource-capped backup worker container (#1955) — the old in-process
// host-agent backend that OOM'd the box (#1894) is retired. The worker launch +
// status polling is covered by backupWorker/launcher.test.ts and
// backupWorker/service.test.ts; the worker's own staging engine (selection /
// exclude / strip / bulk copy / tar) is covered by the backup-worker package's
// staging.test.ts. The producer's remaining responsibilities (local-seed staging,
// NAS write/prune/list/fetch/delete, scheduler) are tested below.

describe('backupServiceToNas', () => {
  it('uploads the tar and a meta sidecar under sb-backup/', async () => {
    const src = await mkTmp();
    await writeFile(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');

    const result = await backupServiceToNas('adguard', { serviceDataDir: src });

    // #1865 — a dated slot per run, not a single overwritten adguard.tar.
    expect(result.tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/);
    expect(result.metaName).toBe(`${result.tarName}.meta.json`);
    expect(result.size).toBeGreaterThan(0);
    expect(result.meta.schemaVersion).toBe(1);
    expect(result.meta.service).toBe('adguard');
    expect(result.meta.nodeId).toBe(os.hostname());

    const uploadPaths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/${result.tarName}`);
    expect(uploadPaths).toContain(`${NAS_BACKUP_DIR}/${result.metaName}`);

    const metaCall = mockNas.nasUpload.mock.calls.find(c => c[0].endsWith('.meta.json'))!;
    const metaJson = JSON.parse((metaCall[1] as Buffer).toString('utf8'));
    expect(metaJson.service).toBe('adguard');
  });

  it('rejects a service with no manifest without touching the NAS', async () => {
    // immich has persistent volumes but no config-backup manifest (all bulk —
    // photo library + Postgres, EXCLUDED_BULK_VOLUMES), so it has no tarball.
    await expect(backupServiceToNas('immich')).rejects.toThrow(/No backup manifest/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });

  // (data-dir resolution for the no-override box path is covered by the
  // "via the host agent" describe block above, which also passes DATA_DIR.)
});

describe('read-back', () => {
  it('lists dated snapshots grouped per service (newest first), drops sidecars, keeps bare legacy slots (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant-20260615-0531.tar', size: 100 },
      { name: 'home-assistant-20260615-0531.tar.meta.json', size: 20 }, // sidecar — not a snapshot
      { name: 'home-assistant-20260614-0530.tar', size: 90 },
      { name: 'adguard.tar', size: 50 }, // bare legacy single-slot — still listable
    ]);
    const list = await listServiceBackups();
    expect(list).toEqual([
      // adguard (A→Z) first; its bare slot has a null stamp + null createdAt.
      { service: 'adguard', tarName: 'adguard.tar', size: 50, stamp: null, createdAt: null },
      // home-assistant newest snapshot first; createdAt derived from the stamp (#1890).
      { service: 'home-assistant', tarName: 'home-assistant-20260615-0531.tar', size: 100, stamp: '20260615-0531', createdAt: '2026-06-15T05:31:00.000Z' },
      { service: 'home-assistant', tarName: 'home-assistant-20260614-0530.tar', size: 90, stamp: '20260614-0530', createdAt: '2026-06-14T05:30:00.000Z' },
    ]);
    expect(mockNas.nasList).toHaveBeenCalledWith(NAS_BACKUP_DIR);
  });

  it('latestServiceBackupName resolves the most-recent dated slot, preferring it over a bare legacy slot (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([
      { name: 'home-assistant.tar', size: 10 }, // bare legacy — oldest
      { name: 'home-assistant-20260614-0530.tar', size: 90 },
      { name: 'home-assistant-20260615-0531.tar', size: 100 },
    ]);
    expect(await latestServiceBackupName('home-assistant')).toBe('home-assistant-20260615-0531.tar');
  });

  it('latestServiceBackupName falls back to a bare legacy slot when it is the only snapshot (#1865)', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'adguard.tar', size: 50 }]);
    expect(await latestServiceBackupName('adguard')).toBe('adguard.tar');
  });

  it('latestServiceBackupName returns null when the service has no backup', async () => {
    mockNas.nasList.mockResolvedValue([{ name: 'adguard.tar', size: 50 }]);
    expect(await latestServiceBackupName('home-assistant')).toBeNull();
  });

  it('fetches a tar plus its parsed meta sidecar', async () => {
    mockNas.nasDownload.mockImplementation(async (p: string) =>
      p.endsWith('.meta.json')
        ? Buffer.from(JSON.stringify({ service: 'hermes', schemaVersion: 1, createdAt: 'now', nodeId: 'box' }))
        : Buffer.from('TARBYTES'),
    );
    const { tar, meta } = await fetchServiceBackup('hermes.tar');
    expect(tar.toString()).toBe('TARBYTES');
    expect(meta?.service).toBe('hermes');
    expect(mockNas.nasDownload).toHaveBeenCalledWith(`${NAS_BACKUP_DIR}/hermes.tar`);
  });

  it('returns meta=null when the sidecar is missing', async () => {
    mockNas.nasDownload.mockImplementation(async (p: string) => {
      if (p.endsWith('.meta.json')) throw new Error('550 not found');
      return Buffer.from('TARBYTES');
    });
    const { tar, meta } = await fetchServiceBackup('hermes.tar');
    expect(tar.toString()).toBe('TARBYTES');
    expect(meta).toBeNull();
  });

  it('strips any directory component from the requested name and rejects non-tar', async () => {
    mockNas.nasDownload.mockResolvedValue(Buffer.from('x'));
    await fetchServiceBackup('../../etc/passwd.tar');
    expect(mockNas.nasDownload).toHaveBeenCalledWith(`${NAS_BACKUP_DIR}/passwd.tar`);
    await expect(fetchServiceBackup('hermes.json')).rejects.toThrow(/Not a service backup tar/);
  });
});

describe('dated rotation + retention pruning (#1865)', () => {
  // Back the NAS mock with an in-memory store so multiple backup runs accumulate
  // dated slots and pruning actually removes the oldest, end-to-end.
  let store: Map<string, Buffer>;
  beforeEach(() => {
    store = new Map();
    mockNas.nasUpload.mockImplementation(async (p: string, data: Buffer) => { store.set(p, Buffer.from(data)); });
    mockNas.nasList.mockImplementation(async (dir = '') => {
      const prefix = dir ? `${dir}/` : '';
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ name: k.slice(prefix.length), size: v.length }));
    });
    mockNas.nasRemove.mockImplementation(async (p: string) => { store.delete(p); });
  });

  /** The dated tar slots (no sidecars) currently in the store, for a service. */
  function slots(service: string): string[] {
    return [...store.keys()]
      .map(k => k.slice(`${NAS_BACKUP_DIR}/`.length))
      .filter(n => new RegExp(`^${service}-\\d{8}-\\d{4}\\.tar$`).test(n))
      .sort();
  }

  it('each backup run writes a NEW dated file rather than overwriting one slot', async () => {
    const tar = Buffer.alloc(1024, 1);
    // Three runs at distinct minutes — distinct dated slots, none overwritten.
    vi.useFakeTimers();
    try {
      for (const t of ['2026-06-13T05:31:00Z', '2026-06-14T05:31:00Z', '2026-06-15T05:31:00Z']) {
        vi.setSystemTime(new Date(t));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(slots('adguard')).toEqual([
      'adguard-20260613-0531.tar',
      'adguard-20260614-0531.tar',
      'adguard-20260615-0531.tar',
    ]);
  });

  it('prunes the oldest snapshots beyond the configured retention (keep N), removing sidecars too', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {}, externalBackup: { enabled: true, retention: 2 } });
    const tar = Buffer.alloc(1024, 2);
    vi.useFakeTimers();
    try {
      for (const t of ['2026-06-12T05:31:00Z', '2026-06-13T05:31:00Z', '2026-06-14T05:31:00Z', '2026-06-15T05:31:00Z']) {
        vi.setSystemTime(new Date(t));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    // Only the 2 most-recent remain; older ones AND their sidecars are gone.
    expect(slots('adguard')).toEqual(['adguard-20260614-0531.tar', 'adguard-20260615-0531.tar']);
    expect(store.has(`${NAS_BACKUP_DIR}/adguard-20260612-0531.tar`)).toBe(false);
    expect(store.has(`${NAS_BACKUP_DIR}/adguard-20260612-0531.tar.meta.json`)).toBe(false);
  });

  it('a bare legacy <service>.tar is pruned first (sorts oldest) once retention is reached', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {}, externalBackup: { enabled: true, retention: 1 } });
    // Seed a pre-#1865 single slot, then one dated run with retention 1.
    store.set(`${NAS_BACKUP_DIR}/adguard.tar`, Buffer.alloc(512, 9));
    store.set(`${NAS_BACKUP_DIR}/adguard.tar.meta.json`, Buffer.from('{}'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T05:31:00Z'));
      await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 3));
    } finally {
      vi.useRealTimers();
    }
    // The bare legacy slot is gone; only the new dated snapshot survives.
    expect(store.has(`${NAS_BACKUP_DIR}/adguard.tar`)).toBe(false);
    expect(slots('adguard')).toEqual(['adguard-20260615-0531.tar']);
  });

  it('defaults retention to DEFAULT_BACKUP_RETENTION when unset', async () => {
    expect(DEFAULT_BACKUP_RETENTION).toBe(7);
    const tar = Buffer.alloc(1024, 4);
    vi.useFakeTimers();
    try {
      // 9 runs, no retention configured → keep 7, prune 2 oldest.
      for (let d = 1; d <= 9; d++) {
        vi.setSystemTime(new Date(`2026-06-${String(d).padStart(2, '0')}T05:31:00Z`));
        await stageUploadedServiceTar('adguard', tar);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(slots('adguard')).toHaveLength(DEFAULT_BACKUP_RETENTION);
    expect(slots('adguard')[0]).toBe('adguard-20260603-0531.tar'); // oldest kept = day 3
  });
});

describe('capacity-aware pruning + partial-file sweep (#2873)', () => {
  // Same in-memory NAS as the #1865 block, plus a switch that makes the next N
  // uploads fail the way a full FritzBox share does.
  let store: Map<string, Buffer>;
  let failUploads: number;

  const p = (name: string) => `${NAS_BACKUP_DIR}/${name}`;

  /** Seed a complete snapshot (tar + paired sidecar) of `size` bytes. */
  function seedSnapshot(name: string, size: number): void {
    store.set(p(name), Buffer.alloc(size, 1));
    store.set(p(`${name}.meta.json`), Buffer.from('{"schemaVersion":1}'));
  }

  function names(): string[] {
    return [...store.keys()].map(k => k.slice(`${NAS_BACKUP_DIR}/`.length)).sort();
  }

  beforeEach(() => {
    store = new Map();
    failUploads = 0;
    mockNas.nasUpload.mockImplementation(async (remote: string, data: Buffer) => {
      if (failUploads > 0) {
        failUploads--;
        throw new Error(`553 ${remote}: No space left on device.`);
      }
      store.set(remote, Buffer.from(data));
    });
    mockNas.nasList.mockImplementation(async (dir = '') => {
      const prefix = dir ? `${dir}/` : '';
      return [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ name: k.slice(prefix.length), size: v.length }));
    });
    mockNas.nasRemove.mockImplementation(async (remote: string) => { store.delete(remote); });
  });

  it('(a) recovers from a full share: the failed upload prunes across services and retries once', async () => {
    seedSnapshot('adguard-20260601-0531.tar', 1024);
    seedSnapshot('adguard-20260610-0531.tar', 1024);
    seedSnapshot('syncthing-20260602-0531.tar', 1024);
    seedSnapshot('syncthing-20260611-0531.tar', 1024);
    failUploads = 1; // the first tar upload hits "No space left on device"

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-20T05:31:00Z'));
      const res = await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7));
      expect(res.tarName).toBe('adguard-20260620-0531.tar');
    } finally {
      vi.useRealTimers();
    }

    // The retry landed the snapshot …
    expect(store.has(p('adguard-20260620-0531.tar'))).toBe(true);
    expect(store.has(p('adguard-20260620-0531.tar.meta.json'))).toBe(true);
    // … after the oldest snapshot on the share was pruned to make room …
    expect(store.has(p('adguard-20260601-0531.tar'))).toBe(false);
    expect(store.has(p('adguard-20260601-0531.tar.meta.json'))).toBe(false);
    // … and every service still has at least its newest copy.
    expect(store.has(p('syncthing-20260611-0531.tar'))).toBe(true);
    expect(store.has(p('adguard-20260610-0531.tar'))).toBe(true);
  });

  it('(a2) a failure that is NOT out of space is not answered by deleting backups', async () => {
    seedSnapshot('adguard-20260601-0531.tar', 1024);
    seedSnapshot('adguard-20260610-0531.tar', 1024);
    mockNas.nasUpload.mockRejectedValue(new Error('553 adguard.tar: Permission denied.'));

    await expect(stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7))).rejects.toThrow(/Permission denied/);
    // Both snapshots survive: a permissions problem must never prune the share.
    expect(store.has(p('adguard-20260601-0531.tar'))).toBe(true);
    expect(store.has(p('adguard-20260610-0531.tar'))).toBe(true);
  });

  it('(a3) reports "target too small" when even a cross-service prune cannot make room', async () => {
    seedSnapshot('adguard-20260610-0531.tar', 1024); // one copy each — nothing prunable
    seedSnapshot('syncthing-20260611-0531.tar', 1024);
    failUploads = 99; // the share stays full through the retry

    await expect(stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7)))
      .rejects.toThrow(/target too small for one snapshot of each service/);
    // The last copy of each service is still there.
    expect(store.has(p('adguard-20260610-0531.tar'))).toBe(true);
    expect(store.has(p('syncthing-20260611-0531.tar'))).toBe(true);
  });

  it('(b) sweeps orphaned + partial files before writing, keeping paired snapshots', async () => {
    // Kept: a complete dated snapshot, and a bare legacy slot (#1865 — pre-dated
    // backups have no sidecar by construction and must stay restorable).
    seedSnapshot('adguard-20260601-0531.tar', 1024);
    store.set(p('home-assistant.tar'), Buffer.alloc(512, 9));
    // Swept: dated tar with no sidecar, zero-length tar (+ its sidecar),
    // a sidecar whose tar is gone, and a leftover write-test probe file.
    store.set(p('adguard-20260602-0531.tar'), Buffer.alloc(1024, 2));
    store.set(p('adguard-20260603-0531.tar'), Buffer.alloc(0));
    store.set(p('adguard-20260603-0531.tar.meta.json'), Buffer.from('{}'));
    store.set(p('syncthing-20260604-0531.tar.meta.json'), Buffer.from('{}'));
    store.set(p('.sb-write-test-123-1750000000000'), Buffer.from('servicebay-write-test'));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-20T05:31:00Z'));
      await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7));
    } finally {
      vi.useRealTimers();
    }

    expect(names()).toEqual([
      'adguard-20260601-0531.tar',
      'adguard-20260601-0531.tar.meta.json',
      'adguard-20260620-0531.tar',
      'adguard-20260620-0531.tar.meta.json',
      'home-assistant.tar',
    ]);
  });

  it('(b2) leaves a just-written dated slot alone — a concurrent run may still be uploading it', async () => {
    // No sidecar yet, stamped one minute ago: that is an in-flight write, not an
    // abandoned partial, so the sweep must not delete it.
    store.set(p('syncthing-20260620-0530.tar'), Buffer.alloc(1024, 5));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-20T05:31:00Z'));
      await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7));
    } finally {
      vi.useRealTimers();
    }

    expect(store.has(p('syncthing-20260620-0530.tar'))).toBe(true);
  });

  it('(c) cross-service pruning is oldest-first and never drops a service\'s last snapshot', async () => {
    // Each seeded snapshot is comfortably larger than one new tar, so exactly one
    // prune is enough — which is what makes the ORDER observable.
    seedSnapshot('adguard-20260601-0531.tar', 8192); // oldest prunable → goes
    seedSnapshot('adguard-20260610-0531.tar', 8192); // adguard's newest → stays
    seedSnapshot('syncthing-20260602-0531.tar', 8192); // prunable but newer → stays
    seedSnapshot('syncthing-20260611-0531.tar', 8192);
    seedSnapshot('authelia-20260603-0531.tar', 8192); // authelia's ONLY copy → stays
    failUploads = 1;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-20T05:31:00Z'));
      await stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7));
    } finally {
      vi.useRealTimers();
    }

    expect(store.has(p('adguard-20260601-0531.tar'))).toBe(false); // oldest, pruned
    expect(store.has(p('syncthing-20260602-0531.tar'))).toBe(true); // newer, spared
    expect(store.has(p('authelia-20260603-0531.tar'))).toBe(true); // last copy, never pruned
    expect(store.has(p('adguard-20260610-0531.tar'))).toBe(true);
    expect(store.has(p('syncthing-20260611-0531.tar'))).toBe(true);
    expect(store.has(p('adguard-20260620-0531.tar'))).toBe(true);
  });

  it('(c2) a prune failure never fails a backup that would otherwise succeed', async () => {
    mockGetConfig.mockResolvedValue({ templateSettings: {}, externalBackup: { enabled: true, retention: 1 } });
    seedSnapshot('adguard-20260601-0531.tar', 1024);
    mockNas.nasRemove.mockRejectedValue(new Error('550 Permission denied.'));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-20T05:31:00Z'));
      await expect(stageUploadedServiceTar('adguard', Buffer.alloc(1024, 7))).resolves.toMatchObject({
        tarName: 'adguard-20260620-0531.tar',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(store.has(p('adguard-20260620-0531.tar'))).toBe(true);
  });
});

describe('manifest integration', () => {
  it('the real adguard manifest excludes querylog while keeping the config', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    await writeFile(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    await writeFile(src, 'data/querylog.json', '[]');
    const staged = await stageServiceBackup(src, builtinManifest('adguard'), staging);
    expect(staged).toEqual(['conf/AdGuardHome.yaml']);
  });

  it('the real HA manifest drops the re-downloadable HACS frontend cache but keeps the rest of custom_components (#1894)', async () => {
    const src = await mkTmp();
    const staging = await mkTmp();
    // A real HACS integration's code (keep) …
    await writeFile(src, 'custom_components/hacs/__init__.py', 'CODE');
    await writeFile(src, 'custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    // … and the ~2.2k-file re-downloadable static frontend cache (drop).
    await writeFile(src, 'custom_components/hacs/hacs_frontend/static/locale-data/x.json', '{}');
    await writeFile(src, 'custom_components/hacs/hacs_frontend/main.js', 'JUNK');
    await writeFile(src, 'custom_components/hacs_frontend/entrypoint.js', 'JUNK');

    const staged = await stageServiceBackup(src, builtinManifest('home-assistant'), staging);

    // The HACS code + other integrations are staged …
    expect(staged).toContain('custom_components/hacs/__init__.py');
    expect(staged).toContain('custom_components/meross_lan/manifest.json');
    // … but no hacs_frontend cache file is — neither the nested nor the sibling one.
    expect(staged.some(p => p.includes('hacs_frontend'))).toBe(false);
  });
});

describe('stageUploadedServiceTar', () => {
  it('writes the uploaded tar + meta to the NAS in restore layout', async () => {
    const tar = Buffer.alloc(1024, 7); // >=512 bytes, written verbatim
    const res = await stageUploadedServiceTar('adguard', tar);

    const paths = mockNas.nasUpload.mock.calls.map(c => c[0]);
    // #1865 — dated slot, not a single overwritten adguard.tar.
    expect(res.tarName).toMatch(/^adguard-\d{8}-\d{4}\.tar$/);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/${res.tarName}`);
    expect(paths).toContain(`${NAS_BACKUP_DIR}/${res.tarName}.meta.json`);

    const tarCall = mockNas.nasUpload.mock.calls.find(c => datedTarRe('adguard').test(String(c[0])))!;
    expect(tarCall[1]).toEqual(tar); // bytes passed through unchanged
    const metaCall = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('.meta.json'))!;
    expect(JSON.parse(String(metaCall[1])).service).toBe('adguard');
  });

  it('rejects a service with no backup manifest', async () => {
    await expect(stageUploadedServiceTar('not-a-real-service', Buffer.alloc(1024)))
      .rejects.toThrow(/manifest/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });

  it('rejects an empty / non-tar upload', async () => {
    await expect(stageUploadedServiceTar('adguard', Buffer.alloc(10)))
      .rejects.toThrow(/empty|tar/);
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
  });
});

describe('getNextExternalBackupDelayMs', () => {
  it('schedules later today when the run time has not passed yet', () => {
    const now = new Date('2026-06-01T01:00:00Z');
    const delay = getNextExternalBackupDelayMs('03:30', now);
    expect(delay).toBe((2 * 60 + 30) * 60 * 1000); // 2h30m
  });

  it('rolls to tomorrow when the run time already passed today', () => {
    const now = new Date('2026-06-01T04:00:00Z');
    const delay = getNextExternalBackupDelayMs('03:30', now);
    expect(delay).toBe((23 * 60 + 30) * 60 * 1000); // 23h30m
  });

  it('falls back to the default time on an empty value', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const delay = getNextExternalBackupDelayMs('', now);
    expect(delay).toBe((3 * 60 + 30) * 60 * 1000); // default 03:30
  });
});

describe('scheduleExternalNasBackup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T01:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms a daily timer that fires backupInstalledServicesToNas when enabled', async () => {
    // No NAS configured -> producer returns ok:false per installed service, but
    // the timer must still fire and reschedule without throwing.
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' }, installedTemplates: {} });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0); // let the getConfig().then() arm the timer

    // Nothing fired yet (run is 2h30m out)
    expect(mockNas.nasUpload).not.toHaveBeenCalled();
    // Advance to the scheduled run; with no installed services, no upload, no throw.
    await vi.advanceTimersByTimeAsync((2 * 60 + 30) * 60 * 1000);
    // Reschedule armed a fresh getConfig() (timer self-renews) — no error thrown.
    expect(true).toBe(true);
  });

  it('does not arm a timer when externalBackup.enabled is false', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: false } });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('defaults to enabled (arms a timer) when externalBackup is absent', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockGetConfig.mockResolvedValue({ installedTemplates: {} });
    scheduleExternalNasBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe('getNasBackupSchedule (#1890)', () => {
  it('surfaces the configured time + derived next run when enabled', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T01:00:00Z'));
    // next run = 2h30m after 01:00 = 03:30 same day
    expect(s).toEqual({ enabled: true, time: '03:30', nextRunAt: '2026-06-01T03:30:00.000Z' });
  });

  it('rolls the next run to tomorrow when the time already passed today', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: true, time: '03:30' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T04:00:00Z'));
    expect(s.nextRunAt).toBe('2026-06-02T03:30:00.000Z');
  });

  it('reports disabled with no next run when externalBackup.enabled is false', async () => {
    mockGetConfig.mockResolvedValue({ externalBackup: { enabled: false, time: '04:00' } });
    const s = await getNasBackupSchedule(new Date('2026-06-01T01:00:00Z'));
    expect(s).toEqual({ enabled: false, time: '04:00', nextRunAt: null });
  });

  it('defaults to enabled at 03:30 when externalBackup is unset', async () => {
    mockGetConfig.mockResolvedValue({});
    const s = await getNasBackupSchedule(new Date('2026-06-01T00:00:00Z'));
    expect(s).toEqual({ enabled: true, time: '03:30', nextRunAt: '2026-06-01T03:30:00.000Z' });
  });
});

describe('deleteServiceBackup (#1890)', () => {
  it('removes both the tar and its .meta.json sidecar', async () => {
    mockNas.nasRemove.mockResolvedValue(undefined);
    const r = await deleteServiceBackup('home-assistant-20260615-0531.tar');
    expect(r).toEqual({ tarName: 'home-assistant-20260615-0531.tar', metaRemoved: true });
    expect(mockNas.nasRemove).toHaveBeenNthCalledWith(1, `${NAS_BACKUP_DIR}/home-assistant-20260615-0531.tar`);
    expect(mockNas.nasRemove).toHaveBeenNthCalledWith(2, `${NAS_BACKUP_DIR}/home-assistant-20260615-0531.tar.meta.json`);
  });

  it('still succeeds (metaRemoved:false) when the sidecar is absent — a bare legacy slot', async () => {
    mockNas.nasRemove
      .mockResolvedValueOnce(undefined) // tar
      .mockRejectedValueOnce(new Error('550 not found')); // missing sidecar
    const r = await deleteServiceBackup('adguard.tar');
    expect(r).toEqual({ tarName: 'adguard.tar', metaRemoved: false });
    expect(mockNas.nasRemove).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty', ''],
    ['path separator', 'sub/home-assistant.tar'],
    ['parent traversal', '../home-assistant.tar'],
    ['absolute path', '/etc/passwd.tar'],
    ['backslash', 'a\\b.tar'],
    ['NUL byte', 'evil\0.tar'],
    ['not a tar', 'home-assistant.txt'],
  ])('rejects a %s tarName without touching the NAS', async (_label, name) => {
    await expect(deleteServiceBackup(name)).rejects.toThrow();
    expect(mockNas.nasRemove).not.toHaveBeenCalled();
  });
});

// #2876 — a FritzBox that drops the control connection after ~8 services used to
// produce five identical `connect ECONNREFUSED …` rows, one per remaining service.
// That reads as "five broken services" and sends the operator to the wrong fix.
describe('summariseBackupRun — connection drops are ONE fact, not N broken services (#2876)', () => {
  const refused = 'connect ECONNREFUSED 192.168.178.1:21 (control socket)';

  it('reports a clean run as the plain tally', () => {
    expect(summariseBackupRun([
      { service: 'adguard', ok: true },
      { service: 'nginx', ok: true },
    ])).toBe('2/2 services backed up');
  });

  it('groups the connection-level failures and names them once, with the tally', () => {
    const msg = summariseBackupRun([
      { service: 'adguard', ok: true },
      { service: 'authelia', ok: true },
      { service: 'paperless', ok: false, error: refused },
      { service: 'beets', ok: false, error: refused },
      { service: 'radicale', ok: false, error: 'Server sent FIN packet unexpectedly, closing connection.' },
    ]);
    expect(msg).toMatch(/dropped the connection after 2 of 5 services/);
    expect(msg).toContain('paperless, beets, radicale');
    // The five identical rows collapse to one "first error" mention.
    expect(msg.match(/ECONNREFUSED/g)).toHaveLength(1);
    expect(msg).not.toMatch(/Not backed up/);
  });

  it('keeps genuine per-service errors listed separately from the drop', () => {
    const msg = summariseBackupRun([
      { service: 'adguard', ok: true },
      { service: 'nginx', ok: false, error: 'EACCES: permission denied, copyfile database.sqlite' },
      { service: 'paperless', ok: false, error: refused },
    ]);
    expect(msg).toMatch(/dropped the connection after 1 of 3 services/);
    expect(msg).toMatch(/Not backed up: nginx \(EACCES/);
    // nginx must NOT be swept into the connection group — it is a real fault.
    expect(msg).not.toMatch(/never got a write: [^.]*nginx/);
  });

  it('keeps the old shape when nothing was a connection failure', () => {
    expect(summariseBackupRun([
      { service: 'adguard', ok: false, error: 'No config files to back up' },
    ])).toBe('Not backed up: adguard (No config files to back up)');
  });
});
