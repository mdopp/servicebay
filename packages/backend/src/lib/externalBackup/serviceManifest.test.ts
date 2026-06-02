import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  SERVICE_BACKUP_MANIFESTS,
  getServiceManifest,
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

describe('applyStripRules', () => {
  it('strips a targeted file and passes other files through untouched', () => {
    const authelia = getServiceManifest('authelia')!;
    const stripped = applyStripRules(authelia, 'users_database.yml', 'users:\n  a:\n    password: x\n');
    expect(stripped).not.toContain('password');
    const passthrough = applyStripRules(authelia, 'some-other-file.yml', 'password: keep\n');
    expect(passthrough).toBe('password: keep\n');
  });
});
