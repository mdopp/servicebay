/**
 * Multi-source Backup Sync (#1554): the config carries an operator-editable
 * `sources[]` list (dirs + per-source .gitignore-style excludes). Older
 * configs carry the legacy single `sourcePath`/`excludePatterns` pair, which
 * must fold into a one-element list. Multiple sources rsync into distinct
 * subfolders under the target so per-source `--delete` can't collide.
 */
import { describe, it, expect } from 'vitest';
import { resolveBackupSources, type BackupConfig } from './types';
import { assignSourceSubFolders } from './service';

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
