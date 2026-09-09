/**
 * The SHAPE of "what counts as per-service config" — the runtime manifest type,
 * the collectors, and the pure helpers that operate on a manifest list. The
 * backup producer, the `sb-config-upload` CLI, the restore/install/wipe paths
 * AND the sandboxed `@servicebay/backup-worker` (which does the heavy staging
 * in its own capped container) all consume this, so the staging semantics live
 * in exactly one place.
 *
 * Not the LIST, since #2858 slice C. The list used to be
 * `SERVICE_BACKUP_MANIFESTS` right here — a table only ServiceBay's own
 * templates could appear in, which is why a template from another registry
 * could not be backed up at all (#2849). Now each template DECLARES its own
 * backup (`servicebay.backup`), the backend resolves those declarations into
 * this shape (`lib/externalBackup/templateManifests.ts`), and the worker gets
 * the resolved list handed to it on its command line. The table survives only
 * as an empty deprecated shim, below.
 *
 * Why a workspace package (#2733): the worker used to carry a hand-maintained
 * fork of this file with a "keep the two in sync" header, because the sandbox
 * rule is that the worker never imports the backend. That rule is about the
 * backend's runtime — a dependency-free pure-data package is not the backend,
 * and `@servicebay/api-client` is the precedent. One copy, imported by both
 * sides; a drift-detector test is no longer needed because drift is no longer
 * representable.
 *
 * Pure data + pure helpers — no I/O, no imports beyond `js-yaml`. The producer
 * resolves these relative paths against a service's on-disk data dir.
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
export interface NpmSqliteCollector {
  /** Discriminator for which collector the producer runs. */
  kind: 'npm-sqlite';
}

/**
 * `pg_dump` inside the service's OWN Postgres container (#2864, epic #2858).
 *
 * A live Postgres cluster directory is not a backup: copying `pgdata/` while
 * the server runs yields a torn, version-locked tree that no restore path
 * accepts. So the collector takes a logical dump through the container's own
 * `pg_dump` and stages THAT file; `pgdata/` is excluded by the collector
 * itself ({@link pgDumpRemap}) no matter what the manifest or the template
 * declared, so a template can never talk the platform into shipping the raw
 * cluster dir.
 *
 * Only names live here — no password. `pg_dump` runs as the container's own
 * superuser over the local socket (peer/trust inside the container), so no
 * credential ever reaches an argv or a log line.
 */
export interface PgDumpCollector {
  kind: 'pg-dump';
  /** The podman container running this service's Postgres (`<service>-db`). */
  container: string;
  /** Postgres role `pg_dump` connects as. */
  user: string;
  /** Database to dump. */
  database: string;
  /**
   * The raw cluster dir, relative to the service data dir. NEVER staged — the
   * collector adds it to `exclude` on every run. Defaults to `pgdata`.
   */
  pgdata?: string;
  /**
   * Where the dump lands INSIDE the tarball (and therefore where a restore
   * finds it), relative to the service data dir. Defaults to
   * `<database>.dump`. Must not live inside `pgdata`.
   */
  dumpPath?: string;
}

export type BackupCollector = NpmSqliteCollector | PgDumpCollector;

/** Suffix the on-disk dump carries before staging renames it to `dumpPath` —
 *  mirrors npm-sqlite's `.sb-backup`, so a half-written dump can never be
 *  mistaken for the canonical file a restore reads. */
const PG_DUMP_STAGED_SUFFIX = '.sb-dump';
const PG_DUMP_DEFAULT_PGDATA = 'pgdata';

/**
 * The four paths a pg-dump run touches. Pure — shared by the producer (which
 * runs `pg_dump` and copies the file out of the container) and the worker
 * (which stages it), so the two sides cannot drift.
 */
/**
 * Drop trailing `/` characters without a `\/+$` regex — CodeQL rates that
 * pattern polynomial on library input (js/polynomial-redos), and a loop over
 * the tail is linear and just as clear.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

export function pgDumpPaths(collector: PgDumpCollector): {
  /** Raw cluster dir, relative to the service data dir — never staged. */
  pgdataRel: string;
  /** Path inside the tarball (what a restore reads). */
  dumpRel: string;
  /** Path on disk before staging renames it. */
  stagedRel: string;
  /** Path `pg_dump` writes to INSIDE the Postgres container. */
  containerPath: string;
} {
  const dumpRel = (collector.dumpPath ?? `${collector.database}.dump`).trim();
  return {
    pgdataRel: stripTrailingSlashes((collector.pgdata ?? PG_DUMP_DEFAULT_PGDATA).trim()),
    dumpRel,
    stagedRel: `${dumpRel}${PG_DUMP_STAGED_SUFFIX}`,
    // The container's own /tmp, not the mounted cluster dir: the dump leaves
    // the container by `podman cp`, so it never has to be written into (and
    // then excluded out of) the data volume.
    containerPath: `/tmp/sb-${collector.database}${PG_DUMP_STAGED_SUFFIX}`,
  };
}

/** A rel path that would leave the service's data dir (ADR 0002), or `null`. */
function outsideDataDir(rel: string): string | null {
  if (rel === '' || rel === '.') return 'is empty';
  if (rel.startsWith('/') || rel.startsWith('~')) return 'is not relative to the service data dir';
  if (rel.split('/').includes('..')) return 'contains a `..` segment';
  return null;
}

/**
 * Why this pg-dump manifest cannot run, or `[]` when it can. The producer
 * refuses (and logs) rather than execing a half-specified collector — a dump
 * that silently never happens is the failure mode this whole slice exists to
 * prevent.
 */
export function pgDumpCollectorProblems(manifest: ServiceBackupManifest): string[] {
  const collector = manifest.collector;
  if (collector?.kind !== 'pg-dump') return [];
  const problems: string[] = [];
  for (const field of ['container', 'user', 'database'] as const) {
    const value = collector[field];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`\`${field}\` is required`);
    } else if (/\s/.test(value)) {
      problems.push(`\`${field}\` must not contain whitespace (got "${value}")`);
    }
  }
  if (manifest.volume) {
    problems.push(
      '`volume` manifests are not supported by the pg-dump collector — the dump is '
      + 'copied out to the service data dir, which a named-volume manifest does not have',
    );
  }
  const { pgdataRel, dumpRel } = pgDumpPaths(collector);
  for (const [field, rel] of [['pgdata', pgdataRel], ['dumpPath', dumpRel]] as const) {
    const reason = outsideDataDir(rel);
    if (reason) problems.push(`\`${field}\` "${rel}" ${reason}`);
  }
  if (dumpRel === pgdataRel || dumpRel.startsWith(`${pgdataRel}/`)) {
    problems.push(
      `\`dumpPath\` "${dumpRel}" lives inside the excluded cluster dir "${pgdataRel}/", `
      + 'so the dump would be excluded from the tarball it is meant to carry',
    );
  }
  return problems;
}

/**
 * The manifest the STAGING actually runs for a pg-dump service: the dump is
 * staged (under its canonical `dumpPath` name), and `pgdata/` is excluded —
 * by the collector, unconditionally, whatever the manifest or the template
 * declared. A non-pg-dump manifest is returned unchanged.
 */
export function pgDumpRemap(manifest: ServiceBackupManifest): ServiceBackupManifest {
  const collector = manifest.collector;
  if (collector?.kind !== 'pg-dump') return manifest;
  const { pgdataRel, dumpRel, stagedRel } = pgDumpPaths(collector);
  return {
    ...manifest,
    // The declared include list keeps its other paths (media dirs etc.); the
    // dump replaces any hand-declared reference to itself so it is staged
    // exactly once, from the file the collector actually wrote.
    include: [...manifest.include.filter(p => p !== dumpRel && p !== stagedRel), stagedRel],
    exclude: manifest.exclude.includes(pgdataRel)
      ? manifest.exclude
      : [...manifest.exclude, pgdataRel],
    renames: { ...manifest.renames, [stagedRel]: dumpRel },
  };
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
   * key of its own — it backs up a store that belongs to a template installed
   * under a DIFFERENT name. Two shapes, same mechanism:
   *   - a sibling dir of a template's own config (the zwave-js store at
   *     `home-assistant/zwave-js/`, beside HA's `home-assistant/homeassistant/`);
   *   - one app inside a MULTI-APP template (#2595 — `authelia` and `lldap` are
   *     both apps of the `auth` template; `jellyfin` is an app of `media`).
   * `gateOn` names the template whose presence activates this backup, and whose
   * deploy carries this entry through the per-service wipe/restore. Crucially
   * this is a plain `dataSubdir` under DATA_DIR — NOT a `../` traversal off the
   * parent's dir — so it never trips safeTarExtract's `..` refusal or
   * wipeServiceForReinstall's dataDir-prefix guard (those security ratchets stay
   * intact). Omitted for a normal service that gates on its own `service` name.
   *
   * A gate — `gateOn ?? service` — that names no shipped template is ALWAYS a
   * defect, not a config choice: the entry can never activate on any box.
   * `scripts/check-backup-coverage.ts` fails the build on one (#2595).
   */
  gateOn?: string;
  /**
   * The service's state lives in a PODMAN-MANAGED NAMED VOLUME (#2596) — the
   * `claimName` of a kube `PersistentVolumeClaim` — instead of a `{{DATA_DIR}}`
   * subdir. Mutually exclusive with `dataSubdir`: the `include` paths are then
   * relative to the VOLUME's root, not to a stacks subdir.
   *
   * Why this exists: a template sometimes cannot use a hostPath at all.
   * Syncthing's startup `chmod` of its config dir returns EPERM against a bind
   * mount under rootless podman on FCOS (see templates/file-share/template.yml),
   * so `file-share` keeps `config.xml` — the device identity and every folder
   * share — in the named volume `file-share-syncthing-config`. Before #2596 the
   * whole backup path only ever read DATA_DIR-relative paths, so that state was
   * unbackupable AND invisible to the coverage gate.
   *
   * The mechanism: servicebay binds the named volume READ-ONLY into the backup
   * worker container (backupWorker/launcher.ts) under the worker's `--volumes`
   * root; the staging logic is otherwise unchanged. A `volume` no template
   * declares as a PVC is a build-breaking defect, same class as a dead `gateOn`
   * (scripts/check-backup-coverage.ts).
   *
   * RESTORE is deliberately NOT wired for a volume-held manifest yet — writing
   * back into a live service's named volume needs machinery this file-copy path
   * does not have. `resolveServiceDataDir` throws for one, so the restore/wipe
   * paths say so instead of resolving a bogus DATA_DIR path.
   */
  volume?: string;
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
 * DEPRECATED, EMPTY SHIM (#2858 slice C). This table used to be the single
 * source of truth for "what counts as per-service config". It is now empty on
 * purpose: every backup declaration lives on the TEMPLATE that owns the data,
 * as its `servicebay.backup` annotation, and the runtime manifests are built
 * from there by `lib/externalBackup/templateManifests.ts`.
 *
 * Why the move: a table inside ServiceBay can only describe templates that
 * ship inside ServiceBay. A template from another registry could not add a row
 * to it, so it could not be backed up at all (#2849) — and that does not scale
 * with more registries. The template says what it needs; ServiceBay keeps the
 * two limits a template is not trusted to set for itself (the ADR 0002 tier
 * clamp and the path boundary), enforced in the bridge.
 *
 * It stays as an EMPTY export rather than disappearing so the migration is
 * legible for one release and so `scripts/check-backup-coverage.ts` can assert
 * it is still empty — a new row here would be a silent regression to the shape
 * a foreign registry cannot use. Do not add one; add the annotation to the
 * template instead (docs/TEMPLATE_AUTHORING.md).
 */
export const SERVICE_BACKUP_MANIFESTS: readonly ServiceBackupManifest[] = [];

/**
 * Template volumes that are DELIBERATELY not in a backup manifest —
 * bulk/regenerable/credential-coupled data that must never enter a NAS tarball
 * (multi-GB media, photo blobs, the recorder DB, Postgres data dirs reconciled
 * by rekey, caches). The value is the reason. `scripts/check-backup-coverage.ts`
 * treats a volume as covered if it maps to a manifest entry OR appears here — so
 * a new template volume can't silently opt out of the backup contract (#2153).
 *
 * A key is either:
 *   - the `{{DATA_DIR}}`-relative path of a `hostPath` volume (or the bare
 *     `{{VAR}}` name for a whole-volume variable), exactly as the template
 *     declares it; or
 *   - since #2596, the `claimName` of a `PersistentVolumeClaim` — a podman
 *     named volume that holds bulk data rather than config. There is no such
 *     entry today (`file-share-syncthing-config`, the only PVC any template
 *     ships, is small config and IS backed up), but the gate accepts one so a
 *     future bulk named volume opts out on purpose, with a reason, instead of
 *     being invisible.
 */
export const EXCLUDED_BULK_VOLUMES: Readonly<Record<string, string>> = {
  // Regenerable / re-syncable / re-scannable bulk.
  'auth/authelia-config': 'configuration.yml is re-rendered from configuration.yml.mustache on every deploy — regenerable, not state.',
  'home-assistant/matter-server': 'Matter fabric is re-commissioned per reinstall, not restored (project_matter_fabric_not_portable).',
  'media/jellyfin-cache': 'Jellyfin transcode/artwork cache — regenerable.',
  'immich/model-cache': 'ML model cache — re-downloaded on demand.',
  'claude-dev/workspace': 'Ephemeral dev scratch workspace — not household config.',
  'agent-kit/checkout': 'The delivered agent kit (assist catalog + agent CLI + AGENTS.md, ADR 0014/#2908) — a git checkout ServiceBay re-creates at boot and hourly, mounted read-only into the agent containers. Restoring an old copy would reintroduce exactly the second, ageing source that decision exists to prevent.',
  'mosquitto/data': 'Retained MQTT messages — the devices’ own last-published state, which they republish. The broker carries no config here: mosquitto.conf and the password file are re-rendered into the pod from the wizard variables on every deploy.',
  // Heavy household DATA (photos, media, shared files) — never in a tarball.
  JELLYFIN_MEDIA_PATH: 'The media library itself — multi-TB, lives on the RAID.',
  'immich/upload': 'Immich photo/video library — multi-GB blobs, RAID-resident.',
  'file-share/data': 'The shared household files — bulk user data on the RAID.',
  BEETS_MUSIC_PATH: 'The music library beets tags — the file-share bulk tree under another name, RAID-resident.',
  BEETS_AUDIOBOOKS_PATH: 'The audiobook library — same file-share bulk tree, RAID-resident.',
  // Postgres data dirs: credential-coupled, reconciled by rekey (#2165), not
  // restored from a NAS tarball.
  'immich/pgdata': 'Immich Postgres data dir — RAID-resident, rekey-reconciled, not NAS-restored.',
};

/**
 * Find one service's manifest in a RESOLVED list (#2858 slice C). The list is
 * the caller's: the backend resolves it from the installed templates'
 * declarations, the worker gets it handed over on its command line. There is
 * deliberately no lookup-by-name over a global table any more — that global
 * table is what a foreign registry could not contribute to.
 */
export function findServiceManifest(
  manifests: readonly ServiceBackupManifest[],
  service: string,
): ServiceBackupManifest | undefined {
  return manifests.find(m => m.service === service);
}

/**
 * The installedTemplates key whose presence activates this manifest's backup —
 * its own `service` name for a template's own store, or `gateOn` for a store
 * the template declares on another name's behalf (#1594, e.g.
 * `home-assistant-zwave` gates on `home-assistant`).
 */
export function getBackupGate(manifest: ServiceBackupManifest): string {
  return manifest.gateOn ?? manifest.service;
}

/**
 * The sibling-store services that ride a given template's deploy (#1594):
 * every manifest whose `gateOn` is `template`. The install runner carries
 * these through the same per-service wipe + restore as the template itself,
 * since they have no `item.name` of their own to trigger on. Returns `[]` for
 * a template with no sibling stores (the common case).
 */
export function siblingBackupServices(
  manifests: readonly ServiceBackupManifest[],
  template: string,
): string[] {
  return manifests.filter(m => m.gateOn === template).map(m => m.service);
}

/**
 * The manifest list as the worker receives it (#2858 slice C): servicebay
 * resolves the declarations from the installed templates and hands the result
 * to the one-shot container, which never reads a template itself and never
 * imports the backend. This is the schema half of that handover — the worker
 * keeps importing this package for the shape, never for the list.
 *
 * Fail closed: anything that is not an array of objects with a string
 * `service` and a `string[]` `include` THROWS. A worker that silently backed
 * up a subset of what it was asked for would report a green run against a
 * denominator that quietly shrank, which is the #2595 failure mode.
 */
export function parseBackupManifestsJson(raw: string): ServiceBackupManifest[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`backup manifests are not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(doc)) throw new Error('backup manifests must be a JSON array');
  return doc.map((entry, i) => {
    const m = entry as Partial<ServiceBackupManifest> | null;
    if (!m || typeof m !== 'object') throw new Error(`backup manifest [${i}] is not an object`);
    if (typeof m.service !== 'string' || m.service === '') {
      throw new Error(`backup manifest [${i}] has no \`service\` name`);
    }
    if (!Array.isArray(m.include) || m.include.length === 0) {
      throw new Error(`backup manifest "${m.service}" has no \`include\` paths`);
    }
    if (!Array.isArray(m.exclude)) throw new Error(`backup manifest "${m.service}" has no \`exclude\` list`);
    return m as ServiceBackupManifest;
  });
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
