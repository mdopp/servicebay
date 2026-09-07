/**
 * Unit tests for the `servicebay.backup` declaration parser (#2858, slice A).
 *
 * The four rules this contract exists to enforce, one describe each:
 * a valid declaration parses; `backup: none` needs a reason; a path that
 * leaves the service's own data dir is refused with a logged reason
 * (ADR 0002); an unknown collector (or field) is refused rather than ignored.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTemplateBackupYaml,
  dataDirEscapeReason,
} from '@/lib/template/backupContract';

describe('parseTemplateBackupYaml — a valid declaration', () => {
  it('parses every field the manifest carries today', () => {
    const r = parseTemplateBackupYaml(`
dataSubdir: nginx-proxy-manager
collector: npm-sqlite
include:
  - data/database.sqlite
  - config.json
exclude:
  - data/logs
data:
  - media
strip:
  - file: config.yml
    dropYamlKeys: [password]
transform:
  - file: .storage/core.config_entries
    kind: ha-config-entries-addon
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup).toEqual({
      kind: 'declared',
      dataSubdir: 'nginx-proxy-manager',
      volume: undefined,
      collector: { kind: 'npm-sqlite' },
      include: ['data/database.sqlite', 'config.json'],
      exclude: ['data/logs'],
      data: ['media'],
      strip: [{ file: 'config.yml', dropYamlKeys: ['password'] }],
      transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
      stores: {},
    });
  });

  it('defaults the collector to `file` and the optional lists to empty', () => {
    const r = parseTemplateBackupYaml('include: [config.json]\n');
    expect(r.ok).toBe(true);
    if (!r.ok || r.backup.kind !== 'declared') return;
    expect(r.backup.collector).toEqual({ kind: 'file' });
    expect(r.backup.exclude).toEqual([]);
    expect(r.backup.data).toEqual([]);
    expect(r.backup.strip).toEqual([]);
    expect(r.backup.stores).toEqual({});
  });

  it('accepts a configured `pg-dump` collector and a named volume', () => {
    const r = parseTemplateBackupYaml(
      'collector:\n  kind: pg-dump\n  container: paperless-db\n  user: paperless\n  database: paperless\n'
      + 'volume: paperless-data\ninclude: [media]\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.backup.kind !== 'declared') return;
    expect(r.backup.collector).toEqual({
      kind: 'pg-dump', container: 'paperless-db', user: 'paperless', database: 'paperless',
    });
    expect(r.backup.volume).toBe('paperless-data');
  });

  it('refuses a bare `collector: pg-dump` — it names a dump that could never run', () => {
    // Without container/user/database there is nothing to exec. Accepting the
    // bare name would ship a "backup" whose database silently never arrives.
    const r = parseTemplateBackupYaml('collector: pg-dump\ninclude: [media]\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/collector/);
  });

  it('accepts sibling `stores:` and validates each one (#1594/#2595)', () => {
    const r = parseTemplateBackupYaml(
      'stores:\n  authelia:\n    dataSubdir: auth/authelia-data\n    include: [db.sqlite3]\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.backup.kind !== 'declared') return;
    // A template that owns nothing itself declares only stores.
    expect(r.backup.include).toEqual([]);
    expect(r.backup.stores.authelia.include).toEqual(['db.sqlite3']);
  });

  it('applies the ADR 0002 path boundary inside a `stores:` entry too', () => {
    const r = parseTemplateBackupYaml('stores:\n  evil:\n    include: ["../../etc/shadow"]\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/stores\.evil\.include/);
  });

  it('refuses a declaration with neither includes nor stores — say `none` instead', () => {
    const r = parseTemplateBackupYaml('include: []\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/`backup: none`/);
  });

  it('refuses `dataSubdir` and `volume` together', () => {
    const r = parseTemplateBackupYaml('dataSubdir: paperless\nvolume: paperless-db\ninclude: [a]\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/mutually exclusive/);
  });
});

describe('parseTemplateBackupYaml — `backup: none`', () => {
  it('accepts an opt-out that carries a reason', () => {
    const r = parseTemplateBackupYaml('backup: none\nreason: Stateless — re-rendered on every deploy.\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup).toEqual({ kind: 'none', reason: 'Stateless — re-rendered on every deploy.' });
  });

  it('refuses `backup: none` with no reason', () => {
    const r = parseTemplateBackupYaml('backup: none\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/reason/);
  });

  it('refuses `backup: none` with a blank reason', () => {
    const r = parseTemplateBackupYaml('backup: none\nreason: "   "\n');
    expect(r.ok).toBe(false);
  });

  it('refuses any other `backup:` value rather than reading it as a declaration', () => {
    const r = parseTemplateBackupYaml('backup: skip\nreason: because\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/backup: none/);
  });
});

describe('parseTemplateBackupYaml — the ADR 0002 path boundary', () => {
  const escapes: [string, RegExp][] = [
    ['../../etc/shadow', /`\.\.` segment/],
    ['data/../../../etc/passwd', /`\.\.` segment/],
    ['/etc/shadow', /is absolute/],
    ['~/.ssh/id_rsa', /home-relative/],
    ['{{DATA_DIR}}/other', /placeholder/],
  ];

  for (const [path, reason] of escapes) {
    it(`rejects an include of "${path}" with a reason`, () => {
      const r = parseTemplateBackupYaml(`include: ["${path}"]\n`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const joined = r.errors.join('\n');
      expect(joined).toContain(path);
      expect(joined).toMatch(reason);
      expect(joined).toMatch(/ADR 0002/);
    });

    it(`rejects an exclude of "${path}" with a reason`, () => {
      const r = parseTemplateBackupYaml(`include: [config.json]\nexclude: ["${path}"]\n`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.join('\n')).toContain(path);
    });
  }

  it('rejects an escaping `data`, `strip.file` and `transform.file` path too', () => {
    const r = parseTemplateBackupYaml(`
include: [config.json]
data: ['../bulk']
strip:
  - file: /etc/shadow
    dropYamlKeys: [password]
transform:
  - file: ../other/core.config_entries
    kind: ha-config-entries-addon
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(3);
  });

  it('rejects an escaping dataSubdir', () => {
    const r = parseTemplateBackupYaml('dataSubdir: ../nginx\ninclude: [a]\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/leaves the service data dir/);
  });

  it('keeps ordinary nested and dotfile paths inside the boundary', () => {
    expect(dataDirEscapeReason('data/nginx/proxy_host')).toBeNull();
    expect(dataDirEscapeReason('.storage/core.config_entries')).toBeNull();
    expect(dataDirEscapeReason('..hidden/file')).toBeNull();
    expect(dataDirEscapeReason('')).toMatch(/empty/);
  });
});

describe('parseTemplateBackupYaml — unknown values fail loudly', () => {
  it('rejects an unknown collector', () => {
    const r = parseTemplateBackupYaml('collector: rsync\ninclude: [config.json]\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/collector/);
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    const r = parseTemplateBackupYaml('include: [config.json]\nincudle: [typo]\n');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown transform kind', () => {
    const r = parseTemplateBackupYaml(`
include: [config.json]
transform:
  - file: config.json
    kind: rewrite-everything
`);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-mapping body', () => {
    expect(parseTemplateBackupYaml('- config.json\n').ok).toBe(false);
    expect(parseTemplateBackupYaml('none\n').ok).toBe(false);
    expect(parseTemplateBackupYaml('').ok).toBe(false);
  });
});
