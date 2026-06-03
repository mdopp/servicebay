import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  SERVICE_BACKUP_MANIFESTS,
  getServiceManifest,
  getBackupGate,
  getSiblingBackupServices,
  getConfigPaths,
  getDataPaths,
  stripYamlKeys,
  applyStripRules,
  applyTransformRules,
  translateHaAddonConfigEntries,
} from './serviceManifest';

describe('service backup manifests', () => {
  it('covers the #1190 services and excludes vaultwarden', () => {
    const names = SERVICE_BACKUP_MANIFESTS.map(m => m.service);
    expect(names).toEqual(
      expect.arrayContaining(['home-assistant', 'authelia', 'adguard', 'syncthing', 'hermes']),
    );
    expect(getServiceManifest('vaultwarden')).toBeUndefined();
  });

  it('keeps the zwave_js network keys in home-assistant (needed to recover the mesh)', () => {
    expect(getServiceManifest('home-assistant')!.include).toContain('.storage/zwave_js');
  });

  it('uses a glob for lovelace dashboards, not the bare exact name (#1595)', () => {
    const ha = getServiceManifest('home-assistant')!;
    // HA stores dashboards as `.storage/lovelace.<url_path>`; the bare exact
    // include never matched them. The glob must be present and the dropped
    // exact name must be gone.
    expect(ha.include).toContain('.storage/lovelace*');
    expect(ha.include).not.toContain('.storage/lovelace');
  });

  it('backs up HACS code + data so HACS integrations survive a reinstall (#1596)', () => {
    const ha = getServiceManifest('home-assistant')!;
    expect(ha.include).toContain('custom_components');
    expect(ha.include).toContain('.storage/hacs*');
  });

  it('backs up the zwave-js store as a sibling entry gated on home-assistant (#1594)', () => {
    const zw = getServiceManifest('home-assistant-zwave')!;
    expect(zw).toBeDefined();
    // The store is a SIBLING dir under DATA_DIR — a plain dataSubdir, no `../`,
    // so the traversal guards stay intact.
    expect(zw.dataSubdir).toBe('home-assistant/zwave-js');
    expect(zw.gateOn).toBe('home-assistant');
    // settings.json carries the network securityKeys + port + soft-reset.
    expect(zw.include).toContain('settings.json');
    // Kept verbatim — the keys can't be regenerated (trusted-NAS decision).
    expect(zw.strip).toBeUndefined();
  });

  it('getBackupGate returns gateOn for a sibling entry, the service name otherwise', () => {
    expect(getBackupGate(getServiceManifest('home-assistant-zwave')!)).toBe('home-assistant');
    expect(getBackupGate(getServiceManifest('adguard')!)).toBe('adguard');
  });

  it('getSiblingBackupServices lists the stores that ride a template deploy (#1594)', () => {
    expect(getSiblingBackupServices('home-assistant')).toEqual(['home-assistant-zwave']);
    // A template with no sibling stores gets an empty list.
    expect(getSiblingBackupServices('adguard')).toEqual([]);
  });

  it('excludes the recorder DB from home-assistant', () => {
    expect(getServiceManifest('home-assistant')!.exclude).toContain('home-assistant_v2.db');
  });

  it('backs up NPM as a first-class entry: db + certs, no strip, in-container collector (#1528)', () => {
    const npm = getServiceManifest('nginx')!;
    expect(npm).toBeDefined();
    // Template name is `nginx` but data lives under nginx-proxy-manager/.
    expect(npm.dataSubdir).toBe('nginx-proxy-manager');
    expect(npm.include).toEqual(
      expect.arrayContaining(['data/database.sqlite', 'letsencrypt', 'data/custom_ssl']),
    );
    // Certs + admin hash are kept verbatim — no strip rules (trusted-NAS decision).
    expect(npm.strip).toBeUndefined();
    // database.sqlite is WAL-mode → needs a consistent in-container snapshot.
    expect(npm.collector).toEqual({ kind: 'npm-sqlite' });
    // ACME renewal logs are noise; conf.d server blocks regenerate from the DB.
    expect(npm.exclude).toContain('letsencrypt/logs');
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

describe('config/data classification (#1585)', () => {
  it('getConfigPaths returns the manifest include set (the CONFIG class)', () => {
    const ha = getServiceManifest('home-assistant')!;
    expect(getConfigPaths('home-assistant')).toEqual(ha.include);
    // CONFIG includes the small restorable bits.
    expect(getConfigPaths('home-assistant')).toContain('configuration.yaml');
    expect(getConfigPaths('home-assistant')).toContain('.storage/zwave_js');
  });

  it('getDataPaths returns the large on-RAID artifacts kept through wipe-config', () => {
    expect(getDataPaths('home-assistant')).toContain('home-assistant_v2.db');
    expect(getDataPaths('home-assistant')).toContain('zwave_js_network.db');
  });

  it('CONFIG and DATA are disjoint for home-assistant (recorder db is DATA, mesh keys are CONFIG)', () => {
    const config = new Set(getConfigPaths('home-assistant'));
    const data = getDataPaths('home-assistant');
    // The heavy recorder DB must NOT be in the CONFIG (backed-up) set.
    expect(config.has('home-assistant_v2.db')).toBe(false);
    // No DATA path is also a CONFIG path.
    for (const d of data) expect(config.has(d)).toBe(false);
  });

  it('returns empty arrays for a service with no manifest', () => {
    expect(getConfigPaths('not-a-service')).toEqual([]);
    expect(getDataPaths('not-a-service')).toEqual([]);
  });

  it('a service may declare no DATA class (authelia is config-only)', () => {
    expect(getServiceManifest('authelia')!.data).toBeUndefined();
    expect(getDataPaths('authelia')).toEqual([]);
    expect(getConfigPaths('authelia')).toContain('users_database.yml');
  });
});

describe('applyStripRules', () => {
  it('strips a targeted file and passes other files through untouched', () => {
    const authelia = getServiceManifest('authelia')!;
    const stripped = applyStripRules(authelia, 'users_database.yml', 'users:\n  a:\n    password: x\n');
    expect(stripped).not.toContain('password');
    const passthrough = applyStripRules(authelia, 'some-other-file.yml', 'password: keep\n');
    expect(passthrough).toBe('password: keep\n');
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
    const ha = getServiceManifest('home-assistant')!;
    expect(ha.transform).toEqual([
      { file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' },
    ]);
    const translated = applyTransformRules(ha, '.storage/core.config_entries', supervisorEntries());
    expect(JSON.parse(translated).data.entries[0].data.url).toBe('ws://localhost:3001');
    // A different file is passed through untouched.
    const other = applyTransformRules(ha, 'configuration.yaml', 'default_config:\n');
    expect(other).toBe('default_config:\n');
  });
});
