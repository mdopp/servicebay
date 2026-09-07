import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  SERVICE_BACKUP_MANIFESTS,
  findServiceManifest,
  getBackupGate,
  siblingBackupServices,
  parseBackupManifestsJson,
  stripYamlKeys,
  applyStripRules,
  applyTransformRules,
  translateHaAddonConfigEntries,
  pgDumpPaths,
  pgDumpRemap,
  pgDumpCollectorProblems,
  type PgDumpCollector,
  type ServiceBackupManifest,
} from './index';

/**
 * A resolved manifest set, as servicebay hands it to the worker. The package
 * no longer OWNS a list since #2858 slice C — the declarations live on the
 * templates — so these fixtures are literal, and the tests here cover the
 * pure helpers that operate on whatever list they are given. The content of
 * the built-in declarations is proved in
 * `tests/backend/backup_template_declarations.test.ts`.
 */
const RESOLVED: ServiceBackupManifest[] = [
  { service: 'home-assistant', dataSubdir: 'home-assistant/homeassistant', include: ['configuration.yaml'], exclude: ['logs'] },
  { service: 'home-assistant-zwave', dataSubdir: 'home-assistant/zwave-js', gateOn: 'home-assistant', include: ['settings.json'], exclude: [] },
  { service: 'authelia', dataSubdir: 'auth/authelia-data', gateOn: 'auth', include: ['db.sqlite3'], exclude: [] },
  { service: 'lldap', dataSubdir: 'auth/lldap', gateOn: 'auth', include: ['users.db'], exclude: [] },
  { service: 'adguard', include: ['conf/AdGuardHome.yaml'], exclude: [] },
];

describe('manifest-list helpers (#2858 slice C)', () => {
  it('finds a service in the list it was handed, and nothing outside it', () => {
    expect(findServiceManifest(RESOLVED, 'adguard')?.include).toEqual(['conf/AdGuardHome.yaml']);
    expect(findServiceManifest(RESOLVED, 'not-a-service')).toBeUndefined();
    expect(findServiceManifest([], 'adguard')).toBeUndefined();
  });

  it('getBackupGate returns gateOn for a store declared on another name\'s behalf', () => {
    expect(getBackupGate(findServiceManifest(RESOLVED, 'home-assistant-zwave')!)).toBe('home-assistant');
    expect(getBackupGate(findServiceManifest(RESOLVED, 'authelia')!)).toBe('auth');
    expect(getBackupGate(findServiceManifest(RESOLVED, 'adguard')!)).toBe('adguard');
  });

  it('siblingBackupServices lists the stores that ride a template deploy (#1594)', () => {
    expect(siblingBackupServices(RESOLVED, 'home-assistant')).toEqual(['home-assistant-zwave']);
    expect(siblingBackupServices(RESOLVED, 'auth')).toEqual(['authelia', 'lldap']);
    expect(siblingBackupServices(RESOLVED, 'adguard')).toEqual([]);
  });

  it('the central table is an EMPTY deprecated shim — a row here is a regression (#2858)', () => {
    // A row in this table describes a backup only ServiceBay's own templates
    // can have, which is the limitation #2849/#2858 removed. The coverage gate
    // fails the build on one; this pins the same rule at unit level.
    expect(SERVICE_BACKUP_MANIFESTS).toEqual([]);
  });
});

describe('parseBackupManifestsJson — the worker handover (#2858 slice C)', () => {
  it('round-trips the list servicebay serialises', () => {
    expect(parseBackupManifestsJson(JSON.stringify(RESOLVED))).toEqual(RESOLVED);
  });

  it('THROWS rather than staging a subset — a quiet subset is a shrunken denominator', () => {
    expect(() => parseBackupManifestsJson('nope')).toThrow(/valid JSON/);
    expect(() => parseBackupManifestsJson('{}')).toThrow(/JSON array/);
    expect(() => parseBackupManifestsJson('[null]')).toThrow(/not an object/);
    expect(() => parseBackupManifestsJson('[{"include":["a"],"exclude":[]}]')).toThrow(/`service`/);
    expect(() => parseBackupManifestsJson('[{"service":"a","exclude":[]}]')).toThrow(/`include`/);
    expect(() => parseBackupManifestsJson('[{"service":"a","include":[]}]')).toThrow(/`include`/);
    expect(() => parseBackupManifestsJson('[{"service":"a","include":["x"]}]')).toThrow(/`exclude`/);
  });
});

describe('stripYamlKeys', () => {
  it('drops password hashes from an authelia users_database while keeping the rest', () => {
    const src = `users:
  michael:
    displayname: Michael
    password: $argon2id$v=19$secrethash
    email: m@example.com
    groups:
      - admins
`;
    const out = stripYamlKeys(src, ['password']);
    const parsed = yaml.load(out) as { users: Record<string, Record<string, unknown>> };
    expect(parsed.users.michael.password).toBeUndefined();
    expect(parsed.users.michael.displayname).toBe('Michael');
    expect(parsed.users.michael.email).toBe('m@example.com');
    expect(parsed.users.michael.groups).toEqual(['admins']);
    expect(out).not.toContain('secrethash');
  });

  it('returns the original content unchanged when it is not valid YAML', () => {
    const garbage = '\t: : not: yaml: [unclosed';
    expect(stripYamlKeys(garbage, ['password'])).toBe(garbage);
  });
});

describe('applyStripRules', () => {
  // No shipped manifest declares a strip rule today (#2595 retired the last one
  // with the `hermes` entry), so the rule engine is exercised against an
  // explicit manifest — it stays live for the next service that needs it.
  const withStrip = {
    service: 'probe',
    include: ['config.yaml'],
    exclude: [],
    strip: [{ file: 'config.yaml', dropYamlKeys: ['api_key'] }],
  };

  it('strips a targeted file and passes other files through untouched', () => {
    const stripped = applyStripRules(withStrip, 'config.yaml', 'api_key: SEKRIT\nmodel: gemma\n');
    expect(stripped).not.toContain('SEKRIT');
    expect(stripped).toContain('gemma');
    const passthrough = applyStripRules(withStrip, 'some-other-file.yml', 'api_key: keep\n');
    expect(passthrough).toBe('api_key: keep\n');
  });

  it('passes everything through for a manifest with no strip rules', () => {
    const lldap = findServiceManifest(RESOLVED, 'lldap')!;
    expect(applyStripRules(lldap, 'users.db', 'IDENTITY-BYTES')).toBe('IDENTITY-BYTES');
  });
});

describe('translateHaAddonConfigEntries (#1595)', () => {
  const supervisorEntries = () =>
    JSON.stringify({
      version: 1,
      minor_version: 4,
      key: 'core.config_entries',
      data: {
        entries: [
          {
            entry_id: 'zw1',
            domain: 'zwave_js',
            title: 'Z-Wave JS',
            data: {
              use_addon: true,
              integration_created_addon: true,
              url: 'ws://core-zwave-js:3000',
            },
          },
          {
            entry_id: 'mt1',
            domain: 'matter',
            data: {
              use_addon: true,
              integration_created_addon: true,
              url: 'ws://core-matter-server:5580/ws',
            },
          },
          {
            entry_id: 'hue1',
            domain: 'hue',
            data: { host: '192.168.1.50', use_addon: true },
          },
          // Supervisor-only family entries (#1601) — dropped on import.
          { entry_id: 'hassio1', domain: 'hassio', data: {} },
          { entry_id: 'cloud1', domain: 'cloud', data: {} },
          { entry_id: 'backup1', domain: 'backup', data: {} },
          { entry_id: 'dc1', domain: 'default_config', data: {} },
        ],
      },
    });

  it('rewrites zwave_js + matter add-on entries to the in-pod containers', () => {
    const out = translateHaAddonConfigEntries(supervisorEntries());
    const parsed = JSON.parse(out) as {
      data: { entries: { domain: string; data: Record<string, unknown> }[] };
    };
    const zw = parsed.data.entries.find(e => e.domain === 'zwave_js')!.data;
    expect(zw.use_addon).toBe(false);
    expect(zw.integration_created_addon).toBe(false);
    // :3000 is taken by NPM under hostNetwork — zwave-js-ui serves :3001.
    expect(zw.url).toBe('ws://localhost:3001');

    const mt = parsed.data.entries.find(e => e.domain === 'matter')!.data;
    expect(mt.use_addon).toBe(false);
    expect(mt.integration_created_addon).toBe(false);
    expect(mt.url).toBe('ws://localhost:5580/ws');
  });

  it('leaves non-add-on entries (e.g. hue) untouched even when use_addon is set', () => {
    const out = translateHaAddonConfigEntries(supervisorEntries());
    const parsed = JSON.parse(out) as {
      data: { entries: { domain: string; data: Record<string, unknown> }[] };
    };
    const hue = parsed.data.entries.find(e => e.domain === 'hue')!.data;
    // hue is not in the translation table → its data is preserved verbatim.
    expect(hue.host).toBe('192.168.1.50');
    expect(hue.use_addon).toBe(true);
    expect(hue.url).toBeUndefined();
  });

  it('drops the Supervisor-only family entries (#1601) but keeps user integrations', () => {
    const out = translateHaAddonConfigEntries(supervisorEntries());
    const parsed = JSON.parse(out) as {
      data: { entries: { domain: string }[] };
    };
    const domains = parsed.data.entries.map(e => e.domain);
    expect(domains).not.toContain('hassio');
    expect(domains).not.toContain('cloud');
    expect(domains).not.toContain('backup');
    expect(domains).not.toContain('default_config');
    // The real integrations are still present.
    expect(domains).toEqual(expect.arrayContaining(['zwave_js', 'matter', 'hue']));
  });

  it('is idempotent: an already-translated backup is returned byte-stable', () => {
    const once = translateHaAddonConfigEntries(supervisorEntries());
    const twice = translateHaAddonConfigEntries(once);
    expect(twice).toBe(once);
  });

  it('drops a Supervisor-only entry even when there is nothing to translate', () => {
    const onlyHassio = JSON.stringify({
      data: {
        entries: [
          { domain: 'hassio', data: {} },
          { domain: 'hue', data: { host: '10.0.0.2' } },
        ],
      },
    });
    const out = translateHaAddonConfigEntries(onlyHassio);
    const parsed = JSON.parse(out) as { data: { entries: { domain: string }[] } };
    expect(parsed.data.entries.map(e => e.domain)).toEqual(['hue']);
  });

  it('returns the content unchanged when there is no add-on entry to translate', () => {
    const noAddon = JSON.stringify({
      data: { entries: [{ domain: 'zwave_js', data: { use_addon: false, url: 'ws://localhost:3001' } }] },
    });
    expect(translateHaAddonConfigEntries(noAddon)).toBe(noAddon);
  });

  it('returns the content unchanged for non-JSON or an unexpected shape', () => {
    expect(translateHaAddonConfigEntries('not json {')).toBe('not json {');
    expect(translateHaAddonConfigEntries('{"data":{}}')).toBe('{"data":{}}');
  });

  it('applyTransformRules runs the HA config-entries translation only on the targeted file', () => {
    const ha: ServiceBackupManifest = {
      ...findServiceManifest(RESOLVED, 'home-assistant')!,
      transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
    };
    const translated = applyTransformRules(ha, '.storage/core.config_entries', supervisorEntries());
    expect(JSON.parse(translated).data.entries[0].data.url).toBe('ws://localhost:3001');
    // A different file is passed through untouched.
    const other = applyTransformRules(ha, 'configuration.yaml', 'default_config:\n');
    expect(other).toBe('default_config:\n');
  });
});

describe('pg-dump collector descriptor (#2864)', () => {
  const paperless = (
    collector: Partial<PgDumpCollector> = {},
  ): ServiceBackupManifest => ({
    service: 'paperless',
    include: ['media'],
    exclude: [],
    collector: {
      kind: 'pg-dump',
      container: 'paperless-db',
      user: 'paperless',
      database: 'paperless',
      ...collector,
    },
  });

  it('defaults the cluster dir to pgdata/ and the dump to <database>.dump', () => {
    const paths = pgDumpPaths(paperless().collector as PgDumpCollector);
    expect(paths).toEqual({
      pgdataRel: 'pgdata',
      dumpRel: 'paperless.dump',
      stagedRel: 'paperless.dump.sb-dump',
      containerPath: '/tmp/sb-paperless.sb-dump',
    });
  });

  it('honours a declared cluster dir and dump path', () => {
    const paths = pgDumpPaths(
      paperless({ pgdata: 'db/data/', dumpPath: 'dumps/pl.dump' }).collector as PgDumpCollector,
    );
    expect(paths.pgdataRel).toBe('db/data');
    expect(paths.dumpRel).toBe('dumps/pl.dump');
    expect(paths.stagedRel).toBe('dumps/pl.dump.sb-dump');
  });

  it('excludes the cluster dir even when the manifest declares it as an include', () => {
    // The whole point: a template cannot talk the platform into shipping a live
    // Postgres data dir, no matter what it declares.
    const declared = paperless();
    const remapped = pgDumpRemap({ ...declared, include: ['media', 'pgdata'] });
    expect(remapped.exclude).toContain('pgdata');
    expect(remapped.include).toContain('paperless.dump.sb-dump');
    expect(remapped.renames).toEqual({ 'paperless.dump.sb-dump': 'paperless.dump' });
    // Unrelated includes survive untouched.
    expect(remapped.include).toContain('media');
  });

  it('stages the dump exactly once even when the manifest also names it', () => {
    const remapped = pgDumpRemap({
      ...paperless(),
      include: ['media', 'paperless.dump', 'paperless.dump.sb-dump'],
    });
    expect(remapped.include.filter(p => p.startsWith('paperless.dump'))).toEqual([
      'paperless.dump.sb-dump',
    ]);
  });

  it('leaves a non-pg-dump manifest alone', () => {
    const npm: ServiceBackupManifest = {
      service: 'nginx', dataSubdir: 'nginx-proxy-manager',
      include: ['data/database.sqlite'], exclude: [], collector: { kind: 'npm-sqlite' },
    };
    expect(pgDumpRemap(npm)).toBe(npm);
    expect(pgDumpCollectorProblems(npm)).toEqual([]);
  });

  it('reports a misconfigured collector instead of running a half-specified dump', () => {
    expect(pgDumpCollectorProblems(paperless({ container: '' }))[0]).toMatch(/`container` is required/);
    expect(pgDumpCollectorProblems(paperless({ user: 'pg user' }))[0]).toMatch(/whitespace/);
    // A dump written inside the excluded cluster dir would be excluded right
    // back out again — the backup would silently carry no database.
    expect(pgDumpCollectorProblems(paperless({ dumpPath: 'pgdata/pl.dump' }))[0])
      .toMatch(/lives inside the excluded cluster dir/);
    // ADR 0002 path boundary.
    expect(pgDumpCollectorProblems(paperless({ dumpPath: '../../etc/pl.dump' }))[0])
      .toMatch(/`\.\.` segment/);
    expect(pgDumpCollectorProblems(paperless({ dumpPath: '/srv/pl.dump' }))[0])
      .toMatch(/not relative to the service data dir/);
    // A named-volume manifest has no data dir to copy the dump into.
    expect(pgDumpCollectorProblems({ ...paperless(), volume: 'paperless-db' })[0])
      .toMatch(/`volume` manifests are not supported/);
  });

  it('accepts a fully specified collector', () => {
    expect(pgDumpCollectorProblems(paperless())).toEqual([]);
  });
});
