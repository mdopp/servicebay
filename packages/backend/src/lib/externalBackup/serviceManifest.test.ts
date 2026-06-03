import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  SERVICE_BACKUP_MANIFESTS,
  getServiceManifest,
  getConfigPaths,
  getDataPaths,
  stripYamlKeys,
  applyStripRules,
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
