/**
 * The single source of truth for "what counts as per-service config" in the
 * FritzBox-NAS config-survival feature (#1190). Both the backup producer and
 * the `sb-config-upload` CLI consume this, so the include/exclude/strip rules
 * live in exactly one place.
 *
 * Pure data + pure helpers — no I/O. The producer resolves these relative
 * paths against a service's on-disk data dir.
 */
import yaml from 'js-yaml';

export interface StripRule {
  /** Config file (relative to the service data dir) the rule applies to. */
  file: string;
  /** YAML keys to remove wherever they appear — e.g. `password` hashes. */
  dropYamlKeys: string[];
}

/**
 * A whole-file content transform applied as a config file enters the tarball
 * (#1595). Distinct from a `StripRule` (which only deletes YAML keys): a
 * transform rewrites values. The one transform we ship rewrites a HA(-OS)
 * backup's `.storage/core.config_entries` from the Supervisor ADD-ON model to
 * ServiceBay's in-pod-container model — a HA-OS backup carries `use_addon:true`
 * + add-on hostnames (`ws://core-zwave-js:3000`) that break setup on the
 * dockerized HA, so the import/backup path translates them once into the tar.
 */
export interface TransformRule {
  /** Config file (relative to the service data dir) the rule applies to. */
  file: string;
  /** Which transform to run — a closed set so the producer stays pure data. */
  kind: 'ha-config-entries-addon';
}

/**
 * Add-on → container translation table for HA config entries (#1595). A HA-OS
 * (Supervisor) backup wires the zwave_js / matter integrations to Supervisor
 * add-on containers (`use_addon:true`, add-on hostnames); in ServiceBay the
 * same integrations talk to the in-pod zwave-js-ui / matter-server over
 * localhost. We rewrite `url` to the in-pod address and clear the add-on flags
 * so HA sets the integration up against the running container instead of
 * looking for a Supervisor add-on that doesn't exist.
 */
const HA_ADDON_ENTRY_TRANSLATIONS: Record<string, { url: string }> = {
  // zwave-js-ui serves its WS on :3001 — :3000 is taken by NPM under hostNetwork.
  zwave_js: { url: 'ws://localhost:3001' },
  matter: { url: 'ws://localhost:5580/ws' },
};

/**
 * Config-entry domains that exist ONLY in the Supervisor (HA-OS) environment and
 * have no working counterpart on ServiceBay's containerised HA (#1601). A HA-OS
 * backup's `.storage/core.config_entries` carries a `hassio` entry (the
 * Supervisor integration itself), plus the `cloud` / `backup` config entries the
 * Supervisor onboarding creates against it. On the container deploy:
 *   - `hassio` cannot load at all — there is no Supervisor to talk to.
 *   - `cloud` and `backup` are core integrations configured via
 *     `configuration.yaml` (single-instance / YAML-only); a stale
 *     Supervisor-created config entry makes HA log a non-fatal setup error and
 *     leaves a broken entry in the UI. They still load via their normal path.
 *   - `default_config` is a meta-component that has no business owning a config
 *     entry on the container deploy; one carried from HA-OS just errors.
 * So we DROP these entries from the array entirely on import — neutralising the
 * noise without removing any legitimate user integration. Conservative by
 * design: only these known-broken Supervisor-family domains are dropped.
 */
const HA_SUPERVISOR_ONLY_DOMAINS: ReadonlySet<string> = new Set([
  'hassio',
  'cloud',
  'backup',
  'default_config',
]);

/**
 * Identifies a service whose backup needs an in-container snapshot step before
 * the file-copy producer reads its data dir — e.g. a live WAL-mode SQLite that
 * a plain `cp` would tear. The producer runs the snapshot inside the service's
 * own container (same exec pattern as `npmAdminRekey`) so it uses the
 * container's bundled `sqlite3`, then stages the snapshot file as a normal
 * include. Pure descriptor — the producer owns the actual exec.
 */
export interface BackupCollector {
  /** Discriminator for which collector the producer runs. */
  kind: 'npm-sqlite';
}

export interface ServiceBackupManifest {
  /** ServiceBay template/service name (also the `installedTemplates` key). */
  service: string;
  /** On-disk data subdir under DATA_DIR, when it differs from `service`
   *  (NPM ships as template `nginx` but stores under `nginx-proxy-manager/`).
   *  Defaults to `service`. */
  dataSubdir?: string;
  /**
   * A SIBLING-store manifest (#1594): this entry has no `installedTemplates`
   * key of its own — it backs up a store that lives in a sibling dir of a real
   * template (e.g. the zwave-js store at `home-assistant/zwave-js/`, beside
   * HA's own `home-assistant/homeassistant/` config). `gateOn` names the
   * template whose presence activates this backup, and whose deploy carries
   * this entry through the per-service wipe/restore. Crucially this is a plain
   * `dataSubdir` under DATA_DIR — NOT a `../` traversal off the parent's dir —
   * so it never trips safeTarExtract's `..` refusal or wipeServiceForReinstall's
   * dataDir-prefix guard (those security ratchets stay intact). Omitted for a
   * normal service that gates on its own `service` name.
   */
  gateOn?: string;
  /**
   * The CONFIG class (#1585): small, backed up to the NAS, restorable.
   * These relative paths/dirs ARE the per-service config worth preserving
   * across a reinstall (HA `configuration.yaml`/automations/`.storage`, the
   * OIDC client, etc.). The backup producer tars exactly these; a
   * `wipe-config` reinstall deletes exactly these from disk and restores them
   * from the NAS on startup. `data[]` (below) is KEPT through a wipe-config.
   */
  include: string[];
  /** Relative paths/dirs to never back up — bulk data, logs, caches, and
   *  secrets with no restore value. Conceptually excludes win over includes. */
  exclude: string[];
  /**
   * The DATA class (#1585): large, NEVER backed up, lives on the RAID. These
   * relative paths/dirs are KEPT on disk through a `wipe-config` reinstall
   * (HA `home-assistant_v2.db` recorder history, Immich photo library, Z-Wave
   * mesh db). A `wipe-all` reinstall wipes them; `wipe-config` does not.
   *
   * This is a DECLARATION of the heavy on-RAID artifacts, distinct from
   * `exclude` (which is "don't put this in the backup tarball" — a superset
   * that also covers logs/caches/sessions). Both can name the same path; the
   * intent differs. Optional: a service with no large on-RAID artifacts (e.g.
   * authelia) omits it. Informational/documentary today — wipe-config keeps
   * everything that isn't a CONFIG path regardless — but it makes the
   * config↔data split explicit and is the seam for any future per-class wipe.
   */
  data?: string[];
  /** Per-file key-removal transforms applied before a file enters the tarball. */
  strip?: StripRule[];
  /** Per-file value-rewrite transforms applied before a file enters the
   *  tarball (e.g. HA add-on → container config-entry translation, #1595). */
  transform?: TransformRule[];
  /** Optional in-container snapshot step the producer runs before staging
   *  (e.g. a consistent SQLite `.backup`). */
  collector?: BackupCollector;
  /** Stage a source rel-path under a different rel-path in the tarball. Set by
   *  the collector so a snapshot file (`…sqlite.sb-backup`) lands under its
   *  canonical name (`…sqlite`) on restore. Maps source → tarball path. */
  renames?: Record<string, string>;
}

/**
 * Per-service config scope, transcribed from the table in #1190.
 * vaultwarden is intentionally absent — its vault DB has no reset path and
 * needs its own user-exported backup story, out of scope for this feature.
 */
export const SERVICE_BACKUP_MANIFESTS: readonly ServiceBackupManifest[] = [
  {
    service: 'home-assistant',
    // The dockerized HA stores its config one level down, under
    // `home-assistant/homeassistant/` (the container's /config) — not directly
    // in the stack dir (#1597). The manifest's include paths are relative to
    // THIS config root, matching the HA-OS Supervisor backup layout (its
    // `homeassistant.tar.gz` nests the same files under `data/`, stripped to
    // bare paths on import) and what restoreServiceBackup extracts into.
    dataSubdir: 'home-assistant/homeassistant',
    include: [
      'automations.yaml', 'scripts.yaml', 'scenes.yaml', 'configuration.yaml',
      '.storage/core.config_entries', '.storage/core.device_registry',
      '.storage/core.entity_registry', '.storage/core.area_registry',
      // HA names each dashboard `.storage/lovelace.<url_path>` (`lovelace.lovelace`,
      // `lovelace.map`, …); the bare `.storage/lovelace` exact-match dropped every
      // dashboard's contents (#1595). The trailing-`*` glob catches them all
      // (and still matches `.storage/lovelace_dashboards`, the sidebar list).
      '.storage/lovelace*',
      // zwave_js network keys ARE needed to recover the mesh after a reinstall.
      '.storage/zwave_js',
      // HACS itself + every integration it installed. Without the code, a restore
      // re-seeds config entries for integrations that no longer exist (#1596).
      // Byte-for-byte: a few MB of operator-trusted third-party components.
      'custom_components',
      // HACS's own data store (repo list, installed-version pins) so HACS comes
      // back knowing what it manages: `.storage/hacs.repositories`, `hacs.data`, …
      '.storage/hacs*',
    ],
    exclude: [
      'home-assistant_v2.db', 'home-assistant_v2.db-wal', 'home-assistant_v2.db-shm',
      'history', 'logs', 'home-assistant.log', 'tts', 'image', 'www', 'deps',
      // HACS ships a re-downloadable frontend asset cache (`hacs_frontend` ≈ 2,200
      // tiny locale/static files that HACS re-fetches on demand). It has no config
      // or restore value, and per-file staging it OOM'd the box mid-backup (#1894).
      // The HACS *data store* (`.storage/hacs*`) — what HACS actually manages — is
      // still backed up; only the disposable static cache is dropped.
      'custom_components/hacs/hacs_frontend',
      'custom_components/hacs_frontend',
    ],
    // Large on-RAID artifacts kept through a wipe-config: the recorder history
    // DB (can be many GB) and the Z-Wave mesh DB. The zwave_js *keys* are CONFIG
    // (in `include`) so the mesh re-pairs; the mesh db itself is heavy DATA.
    data: [
      'home-assistant_v2.db', 'home-assistant_v2.db-wal', 'home-assistant_v2.db-shm',
      'zwave_js_network.db',
    ],
    // A HA-OS backup's config entries assume the Supervisor add-on model and
    // fail setup on the dockerized HA. Translate the zwave_js / matter entries
    // to talk to the in-pod containers over localhost (#1595).
    transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
  },
  {
    // The zwave-js-ui store (#1594) — a SIBLING of HA's config dir, at
    // `home-assistant/zwave-js/` (NOT under `home-assistant/homeassistant/`).
    // It has no template/installedTemplates key of its own, so it `gateOn`
    // home-assistant: HA's presence activates this backup, and HA's deploy
    // carries it through wipe/restore. `dataSubdir` is a plain path under
    // DATA_DIR (no `../`), so the traversal guards are untouched.
    service: 'home-assistant-zwave',
    dataSubdir: 'home-assistant/zwave-js',
    gateOn: 'home-assistant',
    include: [
      // settings.json holds the network securityKeys (S0_Legacy + the three S2
      // classes), securityKeysLongRange, the serial port, and enableSoftReset.
      // Without these, every reinstall destroys the entire Z-Wave security
      // context and the secure mesh is unrecoverable. These keys ARE the config
      // worth preserving — like HA's `.storage/zwave_js` and NPM's certs, they
      // are kept verbatim (no strip): a home NAS is the same trust class as the
      // system backup, and the keys cannot be regenerated.
      'settings.json',
      // ServiceBay's own pinned HA-WebSocket-server settings (serverPort 3001).
      'sb-external-settings.json',
    ],
    exclude: [
      // The node DB / store cache re-pairs from the mesh + lives on the RAID;
      // logs are noise.
      'logs', 'store.jsonl',
    ],
    // The mesh node DB is heavy DATA kept through a wipe-config (re-pairing the
    // whole mesh is expensive); the keys above are CONFIG that re-secures it.
    data: ['store.jsonl'],
  },
  {
    service: 'authelia',
    include: ['users_database.yml'],
    exclude: [],
    // Usernames, groups, email, display name only — password hashes are
    // stripped; operators reset via email-forgotten after a restore.
    strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
  },
  {
    service: 'adguard',
    // clients (device→tag map), blocklists, DNS rewrites, retention setting.
    include: ['conf/AdGuardHome.yaml'],
    exclude: ['data/querylog.json', 'data/stats.db', 'data/sessions.db', 'data/filters'],
  },
  {
    service: 'syncthing',
    // device list + folder-share definitions; the synced data re-syncs from peers.
    include: ['config.xml'],
    exclude: ['index-v0.14.0.db', 'index'],
    // The synced-folder index re-syncs from peers, but it's a heavy on-RAID
    // artifact worth keeping through a wipe-config rather than re-indexing.
    data: ['index-v0.14.0.db', 'index'],
  },
  {
    service: 'hermes',
    // model selection, prompts, household persona, MCP endpoint list,
    // installed-skills git URLs, household-member personalization.
    include: ['config.yaml'],
    exclude: ['vectordb', 'embeddings', 'conversations', 'history'],
    // The vector store + embeddings are large and rebuildable, but kept on the
    // RAID through a wipe-config (re-embedding is expensive).
    data: ['vectordb', 'embeddings'],
    // LLM API keys are re-entered after a restore.
    strip: [{ file: 'config.yaml', dropYamlKeys: ['api_key', 'apiKey', 'llm_api_key'] }],
  },
  {
    // Nginx Proxy Manager (#1528). Template name is `nginx`; data lives under
    // `nginx-proxy-manager/` (`data/` ← /data, `letsencrypt/` ← /etc/letsencrypt).
    service: 'nginx',
    dataSubdir: 'nginx-proxy-manager',
    include: [
      // proxy hosts, redirects, streams, access lists, the admin user/hash.
      'data/database.sqlite',
      // ACME account + every issued cert + private key.
      'letsencrypt',
      // operator-uploaded custom certs/keys.
      'data/custom_ssl',
    ],
    exclude: [
      // ACME renewal logs are noise; the regenerated nginx server blocks are
      // rebuilt from database.sqlite, so the conf.d copy has no restore value.
      'letsencrypt/logs', 'data/nginx', 'data/logs',
    ],
    // NO strip rules: certs + the admin hash are kept verbatim. The home NAS is
    // the same trust class as the existing system backup, and these secrets are
    // expensive/impossible to regenerate (Let's Encrypt rate limits, access
    // lists) — consistent with HA keeping its zwave_js keys.

    // database.sqlite is WAL-mode (since #1679 the nginx post-deploy flips
    // `journal_mode=WAL`) and live; a plain file-copy can tear it AND would miss
    // committed writes still sitting in the `-wal` sidecar. The producer's
    // collector handles both: it `wal_checkpoint(TRUNCATE)`s the WAL into the
    // main DB, then takes a consistent in-container `sqlite3 .backup` snapshot
    // (over the same exec path npmAdminRekey uses) and stages that single
    // self-contained file under the canonical name. The `-wal`/`-shm` sidecars
    // are never staged (they're not in `include`), so the restored DB is whole.
    collector: { kind: 'npm-sqlite' },
  },
];

export function getServiceManifest(service: string): ServiceBackupManifest | undefined {
  return SERVICE_BACKUP_MANIFESTS.find(m => m.service === service);
}

/**
 * The installedTemplates key whose presence activates this manifest's backup —
 * its own `service` name for a normal entry, or `gateOn` for a sibling-store
 * entry (#1594, e.g. `home-assistant-zwave` gates on `home-assistant`).
 */
export function getBackupGate(manifest: ServiceBackupManifest): string {
  return manifest.gateOn ?? manifest.service;
}

/**
 * The sibling-store manifest services that ride a given template's deploy
 * (#1594): every manifest whose `gateOn` is `template`. The install runner
 * carries these through the same per-service wipe + restore as the template
 * itself, since they have no `item.name` of their own to trigger on. Returns
 * `[]` for a template with no sibling stores (the common case).
 */
export function getSiblingBackupServices(template: string): string[] {
  return SERVICE_BACKUP_MANIFESTS.filter(m => m.gateOn === template).map(m => m.service);
}

/**
 * The CONFIG class for a service (#1585): the relative paths a `wipe-config`
 * reinstall deletes and then restores from the NAS. This is exactly the
 * manifest's `include` set — the small, backed-up, restorable config. Returns
 * `[]` for a service with no manifest (nothing classified as config).
 */
export function getConfigPaths(service: string): string[] {
  return [...(getServiceManifest(service)?.include ?? [])];
}

/**
 * The DATA class for a service (#1585): the large on-RAID artifacts a
 * `wipe-config` reinstall KEEPS (and a `wipe-all` wipes). Returns `[]` when the
 * manifest declares none.
 */
export function getDataPaths(service: string): string[] {
  return [...(getServiceManifest(service)?.data ?? [])];
}

/**
 * Remove `dropKeys` from a YAML document wherever they appear (the top-level
 * mapping and every nested mapping — e.g. each user under authelia's `users:`).
 * Best-effort: returns the original text unchanged if it doesn't parse as YAML.
 */
export function stripYamlKeys(content: string, dropKeys: string[]): string {
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch {
    return content;
  }
  if (doc === undefined || doc === null) return content;
  const drop = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(drop);
      return;
    }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      for (const k of dropKeys) delete rec[k];
      for (const v of Object.values(rec)) drop(v);
    }
  };
  drop(doc);
  return yaml.dump(doc);
}

/** Apply a manifest's strip rules to one file's content. Returns the content
 *  unchanged when no rule targets `file`. */
export function applyStripRules(
  manifest: ServiceBackupManifest,
  file: string,
  content: string,
): string {
  const rule = manifest.strip?.find(r => r.file === file);
  if (!rule) return content;
  return stripYamlKeys(content, rule.dropYamlKeys);
}

/**
 * A single HA config entry — only the fields this translation touches are
 * typed; everything else passes through untouched.
 */
interface HaConfigEntry {
  domain?: string;
  data?: { use_addon?: unknown; integration_created_addon?: unknown; url?: unknown };
}

/**
 * Is this config entry still wired to a Supervisor add-on? True when it flags
 * `use_addon`/`integration_created_addon` or still points at an add-on
 * hostname (`ws://core-…`). An entry already on localhost (a re-imported,
 * previously-translated backup) is false → the translation is idempotent.
 */
function isHaEntryOnAddon(data: NonNullable<HaConfigEntry['data']>): boolean {
  if (data.use_addon === true || data.integration_created_addon === true) return true;
  return typeof data.url === 'string' && data.url.startsWith('ws://core-');
}

/**
 * Translate a HA(-OS) backup's `.storage/core.config_entries` from the
 * Supervisor add-on model to ServiceBay's in-pod-container model (#1595).
 *
 * For each entry whose `domain` is in the translation table (zwave_js, matter)
 * AND which is wired to an add-on (`use_addon:true` and/or an add-on hostname),
 * set `use_addon:false`, `integration_created_addon:false`, and rewrite `url`
 * to the in-pod localhost address. Every other entry — and any zwave_js/matter
 * entry already pointing at localhost (idempotent re-run) — is left byte-stable.
 *
 * Additionally (#1601) DROP the Supervisor-only family entries
 * (`HA_SUPERVISOR_ONLY_DOMAINS`: hassio + the cloud/backup/default_config entries
 * it spawns) that cannot function on the container deploy — they only produce
 * non-fatal setup errors and a broken entry in the UI. Dropping is idempotent:
 * a re-imported (already-cleaned) backup has none left, so it's a no-op.
 *
 * Best-effort: returns the content unchanged if it doesn't parse as JSON or
 * lacks the expected `data.entries[]` array, so a future HA storage-schema
 * change can't make the backup fail (the worst case is the old, manual fix-up).
 */
export function translateHaAddonConfigEntries(content: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return content;
  }
  const data = (doc as { data?: { entries?: unknown } })?.data;
  const entries = data?.entries;
  if (!Array.isArray(entries)) return content;

  let changed = false;
  for (const entry of entries as HaConfigEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    const translation = entry.domain ? HA_ADDON_ENTRY_TRANSLATIONS[entry.domain] : undefined;
    if (!translation) continue;
    const entryData = entry.data;
    if (!entryData || typeof entryData !== 'object') continue;
    if (!isHaEntryOnAddon(entryData)) continue;
    entryData.use_addon = false;
    entryData.integration_created_addon = false;
    entryData.url = translation.url;
    changed = true;
  }

  // Drop the Supervisor-only family entries that can't work on container HA.
  const kept = (entries as HaConfigEntry[]).filter(
    e => !(e && typeof e === 'object' && typeof e.domain === 'string'
      && HA_SUPERVISOR_ONLY_DOMAINS.has(e.domain)),
  );
  if (kept.length !== entries.length) {
    (data as { entries: unknown }).entries = kept;
    changed = true;
  }

  if (!changed) return content;
  return JSON.stringify(doc, null, 2);
}

/** Apply a manifest's transform rules to one file's content. Returns the
 *  content unchanged when no rule targets `file`. */
export function applyTransformRules(
  manifest: ServiceBackupManifest,
  file: string,
  content: string,
): string {
  const rule = manifest.transform?.find(r => r.file === file);
  if (!rule) return content;
  if (rule.kind === 'ha-config-entries-addon') {
    return translateHaAddonConfigEntries(content);
  }
  return content;
}
