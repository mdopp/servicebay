/**
 * Backup-coverage contract (#2153).
 *
 * Every template that declares a PERSISTENT host volume must either:
 *   (a) be covered by a `SERVICE_BACKUP_MANIFESTS` entry (its config lands in
 *       the NAS tarball on reinstall), OR
 *   (b) be listed in `EXCLUDED_BULK_VOLUMES` with a reason (deliberately not
 *       backed up — bulk / regenerable / credential-coupled data).
 *
 * This closes the silent-opt-out gap: before #2153 a new template could ship a
 * `{{DATA_DIR}}/…` hostPath and lose all its state on a disk-loss reinstall with
 * nothing to catch it. This check fails CI when a persistent volume is neither
 * covered nor explicitly excluded.
 *
 * A volume is COVERED by a manifest when its `{{DATA_DIR}}`-relative path equals
 * or is nested under a manifest's data dir (`dataSubdir ?? service`) — e.g. the
 * `adguard/work` + `adguard/conf` volumes are both under the `adguard` manifest,
 * and `file-share/samba-private` is under the `file-share` manifest.
 *
 * Exits 0 (all covered) or 1 (one or more uncovered volumes).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  SERVICE_BACKUP_MANIFESTS,
  EXCLUDED_BULK_VOLUMES,
} from '../packages/backend/src/lib/externalBackup/serviceManifest.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

/** A persistent volume declared by a template. */
interface TemplateVolume {
  template: string;
  /** The raw `path:` value, e.g. `{{DATA_DIR}}/vaultwarden` or `{{JELLYFIN_MEDIA_PATH}}`. */
  raw: string;
  /** Coverage key: `{{DATA_DIR}}`-relative subpath, or the bare `{{VAR}}` token. */
  key: string;
}

/**
 * A hostPath volume is a candidate for the backup contract when it points at
 * the box's persistent data root (`{{DATA_DIR}}/…`) or a whole-volume variable
 * (`{{SOME_MEDIA_PATH}}`). Device passthroughs (`{{ZWAVE_DEVICE}}`) and in-pod /
 * ephemeral mounts are NOT persistent household state — a volume rooted at a
 * bare device/`/dev`/`/run` path is skipped. We include `{{DATA_DIR}}/…` and any
 * single `{{VAR}}` whose name reads like a data path (ends in `_PATH`/`_DIR`).
 */
function toCoverageKey(raw: string): string | null {
  const dataDir = raw.match(/^\{\{DATA_DIR\}\}\/(.+)$/);
  if (dataDir) return dataDir[1].replace(/\/+$/, '');
  const bareVar = raw.match(/^\{\{([A-Z0-9_]+)\}\}$/);
  if (bareVar) {
    const name = bareVar[1];
    if (name === 'DATA_DIR') return null; // the root itself, not a leaf volume
    if (/_(PATH|DIR)$/.test(name)) return raw.slice(2, -2); // e.g. JELLYFIN_MEDIA_PATH
    return null; // device/port/other vars — not a persistent data volume
  }
  return null; // absolute host paths (devices, /run, in-pod) — not our contract
}

/** Extract every `path:` under a `hostPath:` block from a template's YAML text. */
function extractHostPathVolumes(template: string, yamlText: string): TemplateVolume[] {
  const lines = yamlText.split('\n');
  const vols: TemplateVolume[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*hostPath:\s*$/.test(lines[i])) continue;
    // The `path:` belongs to this hostPath block — scan the next few lines.
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/^\s*path:\s*(\S+)\s*$/);
      if (m) {
        const raw = m[1];
        const key = toCoverageKey(raw);
        if (key) vols.push({ template, raw, key });
        break;
      }
      if (/^\s*hostPath:\s*$/.test(lines[j])) break; // next block — malformed, bail
    }
  }
  return vols;
}

/** The `{{DATA_DIR}}`-relative data dir a manifest owns (dataSubdir ?? service). */
function manifestDataDirs(): string[] {
  return SERVICE_BACKUP_MANIFESTS.map(m => (m.dataSubdir ?? m.service).replace(/\/+$/, ''));
}

/** Is `key` equal to, or nested under, any covered root in `roots`? */
function isUnder(key: string, roots: string[]): boolean {
  return roots.some(root => key === root || key.startsWith(root + '/'));
}

function main(): void {
  const manifestRoots = manifestDataDirs();
  const excludedRoots = Object.keys(EXCLUDED_BULK_VOLUMES).map(k => k.replace(/\/+$/, ''));

  const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const uncovered: TemplateVolume[] = [];
  let checked = 0;

  for (const template of templates) {
    const tmplPath = path.join(TEMPLATES_DIR, template, 'template.yml');
    if (!existsSync(tmplPath)) continue;
    const vols = extractHostPathVolumes(template, readFileSync(tmplPath, 'utf8'));
    for (const vol of vols) {
      checked++;
      const covered = isUnder(vol.key, manifestRoots) || isUnder(vol.key, excludedRoots);
      if (!covered) uncovered.push(vol);
    }
  }

  if (uncovered.length > 0) {
    console.error('✗ backup-coverage contract (#2153): persistent volume(s) with no manifest entry and no EXCLUDED_BULK_VOLUMES marker:\n');
    for (const v of uncovered) {
      console.error(`  ${v.template}: ${v.raw}`);
    }
    console.error('\nAdd a SERVICE_BACKUP_MANIFESTS entry for it, or list it in EXCLUDED_BULK_VOLUMES with a reason.');
    console.error('Both live in packages/backend/src/lib/externalBackup/serviceManifest.ts (mirror the worker copy).');
    process.exit(1);
  }

  console.log(`✓ backup-coverage: ${checked} persistent template volume(s) all covered (manifest or explicit bulk-exclude).`);
}

main();
