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

export interface ServiceBackupManifest {
  /** ServiceBay template/service name. */
  service: string;
  /** Relative paths/dirs that ARE config worth preserving across a reinstall. */
  include: string[];
  /** Relative paths/dirs to never back up — bulk data, logs, caches, and
   *  secrets with no restore value. Conceptually excludes win over includes. */
  exclude: string[];
  /** Per-file transforms applied before a file enters the tarball. */
  strip?: StripRule[];
}

/**
 * Per-service config scope, transcribed from the table in #1190.
 * vaultwarden is intentionally absent — its vault DB has no reset path and
 * needs its own user-exported backup story, out of scope for this feature.
 */
export const SERVICE_BACKUP_MANIFESTS: readonly ServiceBackupManifest[] = [
  {
    service: 'home-assistant',
    include: [
      'automations.yaml', 'scripts.yaml', 'scenes.yaml', 'configuration.yaml',
      '.storage/core.config_entries', '.storage/core.device_registry',
      '.storage/core.entity_registry', '.storage/core.area_registry',
      '.storage/lovelace', '.storage/lovelace_dashboards',
      // zwave_js network keys ARE needed to recover the mesh after a reinstall.
      '.storage/zwave_js',
    ],
    exclude: [
      'home-assistant_v2.db', 'home-assistant_v2.db-wal', 'home-assistant_v2.db-shm',
      'history', 'logs', 'home-assistant.log', 'tts', 'image', 'www', 'deps',
    ],
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
  },
  {
    service: 'hermes',
    // model selection, prompts, household persona, MCP endpoint list,
    // installed-skills git URLs, household-member personalization.
    include: ['config.yaml'],
    exclude: ['vectordb', 'embeddings', 'conversations', 'history'],
    // LLM API keys are re-entered after a restore.
    strip: [{ file: 'config.yaml', dropYamlKeys: ['api_key', 'apiKey', 'llm_api_key'] }],
  },
];

export function getServiceManifest(service: string): ServiceBackupManifest | undefined {
  return SERVICE_BACKUP_MANIFESTS.find(m => m.service === service);
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
