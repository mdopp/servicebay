// Per-service config-backup manifest — the worker's copy of "what counts as
// per-service config" (#1190 / #1955).
//
// This is the SAME include/exclude/strip/transform spec the backend's
// externalBackup/serviceManifest.ts carries; it lives here too because the heavy
// staging now runs in THIS worker container (not the control plane), and the
// worker must be self-contained (it can't import the backend at runtime — the
// backend imports FROM the workers, never the reverse). The backend keeps its own
// copy for the restore/install/wipe paths that don't run in the worker. Pure data
// + pure helpers — no I/O. Keep the two in sync when a service's config scope
// changes; a divergence only affects which files land in the tar, caught by the
// backup round-trip tests.

import yaml from 'js-yaml';

export interface StripRule {
  /** Config file (relative to the service data dir) the rule applies to. */
  file: string;
  /** YAML keys to remove wherever they appear — e.g. `password` hashes. */
  dropYamlKeys: string[];
}

export interface TransformRule {
  /** Config file (relative to the service data dir) the rule applies to. */
  file: string;
  /** Which transform to run — a closed set so the engine stays pure data. */
  kind: 'ha-config-entries-addon';
}

/** zwave_js / matter add-on → in-pod container url translations for HA (#1595). */
const HA_ADDON_ENTRY_TRANSLATIONS: Record<string, { url: string }> = {
  zwave_js: { url: 'ws://localhost:3001' },
  matter: { url: 'ws://localhost:5580/ws' },
};

/** Supervisor-only HA config-entry domains dropped on import (#1601). */
const HA_SUPERVISOR_ONLY_DOMAINS: ReadonlySet<string> = new Set([
  'hassio',
  'cloud',
  'backup',
  'default_config',
]);

/** An in-container snapshot step the producer runs before staging (e.g. a
 *  consistent SQLite `.backup`). The snapshot itself is host-side (servicebay's
 *  collector) — the worker only stages the resulting file; this descriptor lets
 *  the worker know a `renames` remap is expected. */
export interface BackupCollector {
  kind: 'npm-sqlite';
}

export interface ServiceBackupManifest {
  /** ServiceBay template/service name (also the `installedTemplates` key). */
  service: string;
  /** On-disk data subdir under the stacks root, when it differs from `service`. */
  dataSubdir?: string;
  /** Sibling-store manifest (#1594): gates on the named template, not its own
   *  service name. */
  gateOn?: string;
  /** CONFIG paths/dirs worth preserving across a reinstall (the tar contents). */
  include: string[];
  /** Paths/dirs to never back up — bulk data, logs, caches, valueless secrets. */
  exclude: string[];
  /** Large on-RAID artifacts a wipe-config KEEPS (informational here). */
  data?: string[];
  /** Per-file key-removal transforms applied before a file enters the tarball. */
  strip?: StripRule[];
  /** Per-file value-rewrite transforms applied before a file enters the tarball. */
  transform?: TransformRule[];
  /** Optional in-container snapshot step run host-side before staging. */
  collector?: BackupCollector;
  /** Stage a source rel-path under a different rel-path in the tarball. */
  renames?: Record<string, string>;
}

/** Per-service config scope, transcribed from the table in #1190. */
export const SERVICE_BACKUP_MANIFESTS: readonly ServiceBackupManifest[] = [
  {
    service: 'home-assistant',
    dataSubdir: 'home-assistant/homeassistant',
    include: [
      'automations.yaml', 'scripts.yaml', 'scenes.yaml', 'configuration.yaml',
      '.storage/core.config_entries', '.storage/core.device_registry',
      '.storage/core.entity_registry', '.storage/core.area_registry',
      '.storage/lovelace*',
      '.storage/zwave_js',
      'custom_components',
      '.storage/hacs*',
    ],
    exclude: [
      'home-assistant_v2.db', 'home-assistant_v2.db-wal', 'home-assistant_v2.db-shm',
      'history', 'logs', 'home-assistant.log', 'tts', 'image', 'www', 'deps',
      'custom_components/hacs/hacs_frontend',
      'custom_components/hacs_frontend',
    ],
    data: [
      'home-assistant_v2.db', 'home-assistant_v2.db-wal', 'home-assistant_v2.db-shm',
      'zwave_js_network.db',
    ],
    transform: [{ file: '.storage/core.config_entries', kind: 'ha-config-entries-addon' }],
  },
  {
    service: 'home-assistant-zwave',
    dataSubdir: 'home-assistant/zwave-js',
    gateOn: 'home-assistant',
    include: ['settings.json', 'sb-external-settings.json'],
    exclude: ['logs', 'store.jsonl'],
    data: ['store.jsonl'],
  },
  {
    service: 'authelia',
    include: ['users_database.yml'],
    exclude: [],
    strip: [{ file: 'users_database.yml', dropYamlKeys: ['password'] }],
  },
  {
    service: 'adguard',
    include: ['conf/AdGuardHome.yaml'],
    exclude: ['data/querylog.json', 'data/stats.db', 'data/sessions.db', 'data/filters'],
  },
  {
    service: 'syncthing',
    include: ['config.xml'],
    exclude: ['index-v0.14.0.db', 'index'],
    data: ['index-v0.14.0.db', 'index'],
  },
  {
    service: 'hermes',
    include: ['config.yaml'],
    exclude: ['vectordb', 'embeddings', 'conversations', 'history'],
    data: ['vectordb', 'embeddings'],
    strip: [{ file: 'config.yaml', dropYamlKeys: ['api_key', 'apiKey', 'llm_api_key'] }],
  },
  {
    service: 'nginx',
    dataSubdir: 'nginx-proxy-manager',
    include: ['data/database.sqlite', 'letsencrypt', 'data/custom_ssl'],
    exclude: ['letsencrypt/logs', 'data/nginx', 'data/logs'],
    collector: { kind: 'npm-sqlite' },
  },
];

export function getServiceManifest(service: string): ServiceBackupManifest | undefined {
  return SERVICE_BACKUP_MANIFESTS.find(m => m.service === service);
}

/** The installedTemplates key whose presence activates this manifest's backup. */
export function getBackupGate(manifest: ServiceBackupManifest): string {
  return manifest.gateOn ?? manifest.service;
}

/**
 * Remove `dropKeys` from a YAML document wherever they appear. Best-effort:
 * returns the original text unchanged if it doesn't parse as YAML.
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

/** Apply a manifest's strip rules to one file's content. */
export function applyStripRules(
  manifest: ServiceBackupManifest,
  file: string,
  content: string,
): string {
  const rule = manifest.strip?.find(r => r.file === file);
  if (!rule) return content;
  return stripYamlKeys(content, rule.dropYamlKeys);
}

interface HaConfigEntry {
  domain?: string;
  data?: { use_addon?: unknown; integration_created_addon?: unknown; url?: unknown };
}

function isHaEntryOnAddon(data: NonNullable<HaConfigEntry['data']>): boolean {
  if (data.use_addon === true || data.integration_created_addon === true) return true;
  return typeof data.url === 'string' && data.url.startsWith('ws://core-');
}

/**
 * Translate a HA(-OS) backup's `.storage/core.config_entries` from the Supervisor
 * add-on model to ServiceBay's in-pod-container model (#1595/#1601). Idempotent;
 * best-effort (returns content unchanged on a parse failure).
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

/** Apply a manifest's transform rules to one file's content. */
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
