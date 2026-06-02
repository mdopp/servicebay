/**
 * Multi-source Backup Sync (#1554): the config carries an operator-editable
 * `sources[]` list (dirs + per-source .gitignore-style excludes). Older
 * configs carry the legacy single `sourcePath`/`excludePatterns` pair, which
 * must fold into a one-element list. Multiple sources rsync into distinct
 * subfolders under the target so per-source `--delete` can't collide.
 */
import { describe, it, expect } from 'vitest';
import { resolveBackupSources, type BackupConfig, type BackupTarget } from './types';
import { assignSourceSubFolders, buildRsyncArgs } from './service';

const base: Omit<BackupConfig, 'sources' | 'sourcePath' | 'excludePatterns'> = {
  enabled: true,
  schedule: 'daily',
  time: '02:00',
  target: { type: 'local', path: '/mnt/backup' },
};

describe('resolveBackupSources', () => {
  it('returns the new sources[] when present', () => {
    const config: BackupConfig = {
      ...base,
      sources: [
        { path: '/mnt/data', excludePatterns: ['*.tmp'] },
        { path: '/mnt/media' },
      ],
    };
    expect(resolveBackupSources(config)).toEqual([
      { path: '/mnt/data', excludePatterns: ['*.tmp'] },
      { path: '/mnt/media' },
    ]);
  });

  it('migrates the legacy single sourcePath/excludePatterns pair', () => {
    const config: BackupConfig = {
      ...base,
      sourcePath: '/mnt/data',
      excludePatterns: ['*.log'],
    };
    expect(resolveBackupSources(config)).toEqual([
      { path: '/mnt/data', excludePatterns: ['*.log'] },
    ]);
  });

  it('drops blank source paths and returns [] when nothing is configured', () => {
    expect(resolveBackupSources({ ...base, sources: [{ path: '  ' }] })).toEqual([]);
    expect(resolveBackupSources({ ...base })).toEqual([]);
  });
});

describe('assignSourceSubFolders', () => {
  it('keeps a single source flat (no subfolder) for backward compatibility', () => {
    const assigned = assignSourceSubFolders([{ path: '/mnt/data' }]);
    expect(assigned).toEqual([{ source: { path: '/mnt/data' } }]);
  });

  it('gives each source its own basename subfolder when there is more than one', () => {
    const assigned = assignSourceSubFolders([
      { path: '/mnt/data' },
      { path: '/mnt/media/' },
    ]);
    expect(assigned.map(a => a.subFolder)).toEqual(['data', 'media']);
  });

  it('disambiguates colliding basenames with a numeric suffix', () => {
    const assigned = assignSourceSubFolders([
      { path: '/mnt/data' },
      { path: '/srv/data' },
      { path: '/var/data' },
    ]);
    expect(assigned.map(a => a.subFolder)).toEqual(['data', 'data-2', 'data-3']);
  });
});

describe('buildRsyncArgs', () => {
  const flags = ['-az', '--delete', '--stats', '--human-readable', '--timeout=300'];

  it('always opens with the standard rsync flags and a trailing-slash source', () => {
    const { args } = buildRsyncArgs('/mnt/data', { type: 'local', path: '/mnt/backup' }, []);
    expect(args.slice(0, flags.length)).toEqual(flags);
    // source is normalised to end with a slash (rsync dir-contents semantics)
    expect(args).toContain('/mnt/data/');
  });

  it('injects an --exclude pair per pattern', () => {
    const { args } = buildRsyncArgs('/mnt/data', { type: 'local', path: '/mnt/backup' }, ['*.tmp', 'cache/']);
    expect(args).toContain('--exclude');
    expect(args.filter(a => a === '--exclude')).toHaveLength(2);
    expect(args).toContain('*.tmp');
    expect(args).toContain('cache/');
  });

  it('local target: appends the subfolder and trailing slash, no mountPath', () => {
    const flat = buildRsyncArgs('/mnt/data', { type: 'local', path: '/mnt/backup' }, []);
    expect(flat.args[flat.args.length - 1]).toBe('/mnt/backup/');
    expect(flat.mountPath).toBeUndefined();

    const sub = buildRsyncArgs('/mnt/data', { type: 'local', path: '/mnt/backup' }, [], 'data');
    expect(sub.args[sub.args.length - 1]).toBe('/mnt/backup/data/');
  });

  it('ssh target: builds the user@host:path destination with an -e ssh command', () => {
    const target: BackupTarget = { type: 'ssh', host: 'nas.local', user: 'sb', path: '/srv/bk', port: 2222 };
    const { args } = buildRsyncArgs('/mnt/data', target, [], 'media');
    expect(args).toContain('-e');
    const sshCmd = args[args.indexOf('-e') + 1];
    expect(sshCmd).toContain('ssh');
    expect(sshCmd).toContain('-p 2222');
    expect(args[args.length - 1]).toBe('sb@nas.local:/srv/bk/media/');
  });

  it('smb target: targets the shared mount point + optional sub-path + subfolder, returns mountPath', () => {
    const target: BackupTarget = { type: 'smb', host: 'nas', share: 'backups', path: 'sb' };
    const { args, mountPath } = buildRsyncArgs('/mnt/data', target, [], 'data', '/tmp/mnt-1');
    expect(mountPath).toBe('/tmp/mnt-1');
    expect(args[args.length - 1]).toBe('/tmp/mnt-1/sb/data/');
  });

  it('nfs target without a sub-path: rsyncs straight into the mount + subfolder', () => {
    const target: BackupTarget = { type: 'nfs', host: 'nas', export: '/export/bk' };
    const { args, mountPath } = buildRsyncArgs('/mnt/media/', target, [], undefined, '/tmp/mnt-2');
    expect(mountPath).toBe('/tmp/mnt-2');
    expect(args[args.length - 1]).toBe('/tmp/mnt-2/');
  });
});
