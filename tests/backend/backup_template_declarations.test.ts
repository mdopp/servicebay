/**
 * The MIGRATION proof for #2858 slice C: what the built-in templates now
 * DECLARE resolves, service by service, to exactly what the deleted
 * `SERVICE_BACKUP_MANIFESTS` table used to say.
 *
 * Why it is written this way. The table was the only description of "what
 * counts as this service's config" for a dozen services, several of them
 * irreplaceable (the family identity store, the vault's JWT signing keys, the
 * Z-Wave network keys, Syncthing's device identity). Moving that description
 * onto the templates is a rewrite of every one of those rows, and a rewrite
 * that drops one path is invisible: the nightly run still says "12/12 services
 * backed up" — against a tarball that quietly lost a file. So the old table is
 * FROZEN here, byte for byte as it stood at 5.31.7, and the resolved
 * declarations are asserted equal to it.
 *
 * This is a one-way ratchet, not a permanent spec: once a template legitimately
 * changes what it backs up, the entry here changes with it (and the diff is the
 * review). Its job is to make the MIGRATION provably lossless, and to leave the
 * old content on the record afterwards. One entry has moved that way since:
 * `jellyfin` dropped `data/jellyfin.db*` (#2885) — see the comment on it.
 */

import { describe, it, expect } from 'vitest';

import { siblingBackupServices, getBackupGate, type ServiceBackupManifest } from '@servicebay/backup-manifest';
import { resolveTemplateBackupDeclaration } from '@/lib/externalBackup/backupDeclaration';
import {
  builtinBackupManifests,
  builtinManifest,
  builtinTemplateNames,
} from '../fixtures/builtinBackupManifests';

/** `SERVICE_BACKUP_MANIFESTS` as it stood before slice C deleted it, plus the
 *  deliberate post-migration edits marked inline (currently: jellyfin, #2885). */
const TABLE_BEFORE_MIGRATION: ServiceBackupManifest[] =
  [
    {
      "service": "home-assistant",
      "dataSubdir": "home-assistant/homeassistant",
      "include": [
        "automations.yaml",
        "scripts.yaml",
        "scenes.yaml",
        "configuration.yaml",
        ".storage/core.config_entries",
        ".storage/core.device_registry",
        ".storage/core.entity_registry",
        ".storage/core.area_registry",
        ".storage/lovelace*",
        ".storage/zwave_js",
        "custom_components",
        ".storage/hacs*"
      ],
      "exclude": [
        "home-assistant_v2.db",
        "home-assistant_v2.db-wal",
        "home-assistant_v2.db-shm",
        "history",
        "logs",
        "home-assistant.log",
        "tts",
        "image",
        "www",
        "deps",
        "custom_components/hacs/hacs_frontend",
        "custom_components/hacs_frontend"
      ],
      "data": [
        "home-assistant_v2.db",
        "home-assistant_v2.db-wal",
        "home-assistant_v2.db-shm",
        "zwave_js_network.db"
      ],
      "transform": [
        {
          "file": ".storage/core.config_entries",
          "kind": "ha-config-entries-addon"
        }
      ]
    },
    {
      "service": "home-assistant-zwave",
      "dataSubdir": "home-assistant/zwave-js",
      "gateOn": "home-assistant",
      "include": [
        "settings.json",
        "sb-external-settings.json"
      ],
      "exclude": [
        "logs",
        "store.jsonl"
      ],
      "data": [
        "store.jsonl"
      ]
    },
    {
      "service": "authelia",
      "dataSubdir": "auth/authelia-data",
      "gateOn": "auth",
      "include": [
        "db.sqlite3",
        "db.sqlite3-wal",
        "db.sqlite3-shm"
      ],
      "exclude": []
    },
    {
      "service": "adguard",
      "include": [
        "conf/AdGuardHome.yaml"
      ],
      "exclude": [
        "data/querylog.json",
        "data/stats.db",
        "data/sessions.db",
        "data/filters"
      ]
    },
    {
      "service": "syncthing",
      "gateOn": "file-share",
      "volume": "file-share-syncthing-config",
      "include": [
        "config.xml",
        "cert.pem",
        "key.pem",
        "https-cert.pem",
        "https-key.pem"
      ],
      "exclude": [
        "index-v0.14.0.db",
        "index-v2",
        "csrftokens.txt",
        "syncthing.log"
      ],
      "data": [
        "index-v0.14.0.db",
        "index-v2"
      ]
    },
    {
      "service": "nginx",
      "dataSubdir": "nginx-proxy-manager",
      "include": [
        "data/database.sqlite",
        "letsencrypt",
        "data/custom_ssl"
      ],
      "exclude": [
        "letsencrypt/logs",
        "data/nginx",
        "data/logs"
      ],
      "collector": {
        "kind": "npm-sqlite"
      }
    },
    {
      "service": "lldap",
      "dataSubdir": "auth/lldap",
      "gateOn": "auth",
      "include": [
        "users.db",
        "users.db-wal",
        "users.db-shm"
      ],
      "exclude": []
    },
    {
      "service": "vaultwarden",
      "include": [
        "db.sqlite3",
        "db.sqlite3-wal",
        "db.sqlite3-shm",
        "rsa_key.pem",
        "rsa_key.pub.pem",
        "config.json"
      ],
      "exclude": [
        "icon_cache",
        "tmp",
        "attachments",
        "sends"
      ],
      "data": [
        "attachments",
        "sends"
      ]
    },
    {
      "service": "radicale",
      "dataSubdir": "radicale/data",
      "include": [
        "collections"
      ],
      "exclude": []
    },
    // #2885 — the one entry that has DELIBERATELY moved off the 5.31.7 table
    // (the ratchet allows it; the diff is the review). `data/jellyfin.db*`
    // came out: Jellyfin keeps the media catalog in the same SQLite file as
    // its users and libraries, so the "config" store was 192 MB of a 198 MB
    // tar. Parameters only now, and the whole `data/` dir is excluded so no
    // future include can pull it back. Accepted consequence: a restore
    // re-adds libraries and re-creates users; playback state is gone.
    {
      "service": "jellyfin",
      "dataSubdir": "media/jellyfin-config",
      "gateOn": "media",
      "include": [
        "config",
        "plugins"
      ],
      "exclude": [
        "cache",
        "log",
        "transcodes",
        "metadata",
        "data"
      ],
      "data": [
        "metadata",
        "cache"
      ]
    },
    {
      "service": "file-share",
      "include": [
        "samba-private",
        "filebrowser-db/filebrowser.db",
        "filebrowser-config"
      ],
      "exclude": []
    },
    {
      "service": "beets",
      "dataSubdir": "beets/config",
      "include": [
        "config.yaml",
        "musiclibrary.db"
      ],
      "exclude": []
    }
  ];

describe('#2858 slice C — the built-in templates declare what the table used to hold', () => {
  it('resolves the SAME set of services', () => {
    expect(builtinBackupManifests().map(m => m.service).sort())
      .toEqual(TABLE_BEFORE_MIGRATION.map(m => m.service).sort());
  });

  for (const before of TABLE_BEFORE_MIGRATION) {
    it(`${before.service}: byte-identical include/exclude/data/strip/transform/collector`, () => {
      expect(builtinManifest(before.service)).toEqual(before);
    });
  }

  it('every template either declares a backup or opts out with a reason — no silence', () => {
    const undeclared = builtinTemplateNames().filter(name => {
      const manifests = builtinBackupManifests().filter(m => (m.gateOn ?? m.service) === name);
      return manifests.length === 0;
    });
    // The three opt-outs, and only those: immich (bulk photos + a live Postgres
    // cluster dir), mosquitto (config re-rendered every deploy), claude-dev
    // (ephemeral scratch). Anything else here is a template that lost its
    // declaration in a refactor.
    expect(undeclared.sort()).toEqual(['claude-dev', 'immich', 'mosquitto']);
  });

  it('the sibling stores still gate on the template that hosts them (#1594/#2595)', () => {
    const all = builtinBackupManifests();
    expect(siblingBackupServices(all, 'home-assistant')).toEqual(['home-assistant-zwave']);
    expect(siblingBackupServices(all, 'auth')).toEqual(['authelia', 'lldap']);
    expect(siblingBackupServices(all, 'media')).toEqual(['jellyfin']);
    expect(siblingBackupServices(all, 'file-share')).toEqual(['syncthing']);
    // A template with no sibling stores gets an empty list.
    expect(siblingBackupServices(all, 'adguard')).toEqual([]);
    // The gate is the declaring template, never the app's own name — the #2595
    // defect that left the SSO server and the identity store un-backed-up.
    expect(getBackupGate(builtinManifest('authelia'))).toBe('auth');
    expect(getBackupGate(builtinManifest('jellyfin'))).toBe('media');
    expect(getBackupGate(builtinManifest('adguard'))).toBe('adguard');
  });
});

describe('the CONFIG/DATA classification survives the move (#1585)', () => {
  it('CONFIG is the include set a wipe-config clears and the restore puts back', () => {
    const ha = builtinManifest('home-assistant');
    expect(ha.include).toContain('configuration.yaml');
    // The Z-Wave network keys are CONFIG — the mesh cannot be re-secured
    // without them — while the mesh DB itself is DATA.
    expect(ha.include).toContain('.storage/zwave_js');
  });

  it('DATA holds the large on-RAID artifacts kept through a wipe-config', () => {
    const ha = builtinManifest('home-assistant');
    expect(ha.data).toContain('home-assistant_v2.db');
    expect(ha.data).toContain('zwave_js_network.db');
  });

  it('CONFIG and DATA stay disjoint — the recorder DB never enters a tarball', () => {
    const ha = builtinManifest('home-assistant');
    const config = new Set(ha.include);
    expect(config.has('home-assistant_v2.db')).toBe(false);
    for (const d of ha.data ?? []) expect(config.has(d)).toBe(false);
    expect(ha.exclude).toContain('home-assistant_v2.db');
  });

  it('jellyfin keeps its parameters and drops the catalog DB (#2885)', () => {
    const jellyfin = builtinManifest('jellyfin');
    // Parameters: server settings + the LDAP plugin config, and the plugins.
    expect(jellyfin.include).toEqual(['config', 'plugins']);
    // The catalog DB is not tier A just because it is a `.db` — it carries the
    // whole media catalog alongside the users/libraries rows and cannot be
    // split, so it stays out and `data/` is excluded wholesale.
    expect(jellyfin.include).not.toContain('data/jellyfin.db');
    expect(jellyfin.exclude).toContain('data');
    for (const wal of ['data/jellyfin.db', 'data/jellyfin.db-wal', 'data/jellyfin.db-shm']) {
      expect(jellyfin.include.some(p => wal === p || wal.startsWith(p + '/'))).toBe(false);
    }
  });

  it('a store may declare no DATA class at all (authelia is config-only)', () => {
    const authelia = builtinManifest('authelia');
    expect(authelia.data).toBeUndefined();
    // The real per-service secrets (TOTP/WebAuthn/OIDC consent) live in the
    // SQLite store; the legacy file-backend YAML is dead and not backed up.
    expect(authelia.include).toContain('db.sqlite3');
    expect(authelia.include).not.toContain('users_database.yml');
    // Encrypted at rest, kept verbatim — no strip.
    expect(authelia.strip).toBeUndefined();
  });
});

describe('the platform-enforced ADR 0002 limits — a hostile declaration cannot get past them', () => {
  /** Resolve one declaration body as if a template shipped it. */
  const resolve = (template: string, body: string | undefined) =>
    resolveTemplateBackupDeclaration(template, body);

  it('a template with NO annotation is a problem, never a silent skip', () => {
    const r = resolve('rogue', undefined);
    expect(r.manifests).toEqual([]);
    expect(r.optOut).toBeNull();
    expect(r.problems.join('\n')).toMatch(/no `servicebay.backup` annotation/);
  });

  it('refuses a path that leaves the service data dir (parse-time boundary)', () => {
    const r = resolve('rogue', 'include:\n  - ../../etc/shadow\n');
    expect(r.manifests).toEqual([]);
    expect(r.problems.join('\n')).toMatch(/`\.\.` segment/);
  });

  it('CLAMPS an include that resolves into a bulk volume, and never ships it', () => {
    // immich/upload is the multi-GB photo library. A template declaring it as
    // config would push the whole library at a NAS share — the tier rule says
    // no, regardless of what the template asked for (ADR 0002).
    const r = resolve('immich', 'include:\n  - upload\n  - config.json\n');
    const [manifest] = r.manifests;
    expect(manifest.include).toEqual(['config.json']);
    // …and the clamped path is pushed onto exclude so nested staging can't
    // reach it either.
    expect(manifest.exclude).toContain('upload');
    expect(r.problems.join('\n')).toMatch(/clamped include "upload"/);
    expect(r.problems.join('\n')).toMatch(/ADR 0002 tier clamp/);
  });

  it('refuses a store whose named volume ServiceBay itself calls bulk', () => {
    const r = resolve('rogue', 'volume: immich/upload\ninclude:\n  - anything\n');
    expect(r.manifests).toEqual([]);
    expect(r.problems.join('\n')).toMatch(/declared bulk in EXCLUDED_BULK_VOLUMES/);
  });

  it('builds NO manifest when the clamp leaves nothing — an empty backup reports "ok"', () => {
    const r = resolve('immich', 'include:\n  - upload\n');
    expect(r.manifests).toEqual([]);
    expect(r.problems.join('\n')).toMatch(/no include path survived/);
  });

  it('an explicit `backup: none` carries its reason and produces no manifest', () => {
    const r = resolve('mosquitto', 'backup: none\nreason: Config is re-rendered every deploy.\n');
    expect(r.manifests).toEqual([]);
    expect(r.optOut).toBe('Config is re-rendered every deploy.');
    expect(r.problems).toEqual([]);
  });
});
