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
 * Bare `{{VAR}}` hostPaths that are NOT persistent household state, each with
 * the reason it is exempt. This is the ONLY way a bare-variable hostPath leaves
 * the coverage check — everything else is a candidate.
 *
 * #2465: the previous rule failed *open*. A bare `{{VAR}}` counted as a
 * persistent volume only when its name ended in `_PATH`/`_DIR`; every other
 * name returned `null` and was dropped before the coverage check saw it — not
 * reported as uncovered, invisible. A template naming its data variable
 * slightly off-pattern (`{{MEDIA_ROOT}}`, `{{PHOTOS}}`) got a green
 * `check:backup-coverage` with a silently un-backed-up volume, which is the one
 * outcome this gate exists to prevent. Now the gate fails *closed*: an
 * off-pattern name is flagged until it is covered, excluded, or (if it really
 * isn't household state) matched by an entry below.
 */
const NON_VOLUME_HOSTPATH_VARS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /_DEVICES?$/, reason: 'device passthrough (e.g. /dev/serial/…), not stored state' },
  { pattern: /_(SOCKET|SOCK)$/, reason: 'host socket mount, not stored state' },
  { pattern: /_PORT$/, reason: 'not a filesystem path' },
];

/** The exemption an off-pattern bare `{{VAR}}` matched, if any. */
function hostPathVarExemption(name: string): string | null {
  return NON_VOLUME_HOSTPATH_VARS.find(e => e.pattern.test(name))?.reason ?? null;
}

/**
 * A hostPath volume is a candidate for the backup contract when it points at
 * the box's persistent data root (`{{DATA_DIR}}/…`) or at a whole-volume
 * variable (`{{JELLYFIN_MEDIA_PATH}}`, `{{MEDIA_ROOT}}`, …). Absolute host
 * paths (`/dev/…`, `/run/…`, in-pod mounts) are outside the contract, and a
 * bare variable is only skipped when it matches `NON_VOLUME_HOSTPATH_VARS`.
 */
function toCoverageKey(raw: string): string | null {
  const dataDir = raw.match(/^\{\{DATA_DIR\}\}\/(.+)$/);
  if (dataDir) return dataDir[1].replace(/\/+$/, '');
  const bareVar = raw.match(/^\{\{([A-Z0-9_]+)\}\}$/);
  if (bareVar) {
    const name = bareVar[1];
    if (name === 'DATA_DIR') return null; // the root itself, not a leaf volume
    if (hostPathVarExemption(name)) return null; // explicitly not stored state
    return name; // fail closed: every other variable volume must be accounted for
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

/**
 * The volumes that satisfy neither a manifest nor an explicit bulk-exclude.
 * Exported so the gate's own coverage decision is testable without the
 * filesystem (tests/scripts/gate-config-truth.test.ts).
 */
function uncoveredVolumes(vols: readonly TemplateVolume[]): TemplateVolume[] {
  const manifestRoots = manifestDataDirs();
  const excludedRoots = Object.keys(EXCLUDED_BULK_VOLUMES).map(k => k.replace(/\/+$/, ''));
  return vols.filter(v => !isUnder(v.key, manifestRoots) && !isUnder(v.key, excludedRoots));
}

function main(): void {
  const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const all: TemplateVolume[] = [];
  for (const template of templates) {
    const tmplPath = path.join(TEMPLATES_DIR, template, 'template.yml');
    if (!existsSync(tmplPath)) continue;
    all.push(...extractHostPathVolumes(template, readFileSync(tmplPath, 'utf8')));
  }

  const checked = all.length;
  const uncovered = uncoveredVolumes(all);

  if (uncovered.length > 0) {
    console.error('✗ backup-coverage contract (#2153): persistent volume(s) with no manifest entry and no EXCLUDED_BULK_VOLUMES marker:\n');
    for (const v of uncovered) {
      console.error(`  ${v.template}: ${v.raw}`);
    }
    console.error('\nAdd a SERVICE_BACKUP_MANIFESTS entry for it, or list it in EXCLUDED_BULK_VOLUMES with a reason.');
    console.error('Both live in packages/backend/src/lib/externalBackup/serviceManifest.ts (mirror the worker copy).');
    console.error('If a bare `{{VAR}}` hostPath is genuinely not stored state (a device, a socket), add a');
    console.error('pattern + reason to NON_VOLUME_HOSTPATH_VARS in scripts/check-backup-coverage.ts (#2465).');
    process.exit(1);
  }

  console.log(`✓ backup-coverage: ${checked} persistent template volume(s) all covered (manifest or explicit bulk-exclude).`);
}

// Run only when invoked as the CLI — `toCoverageKey` / `extractHostPathVolumes`
// / `uncoveredVolumes` are imported by tests/scripts/gate-config-truth.test.ts,
// which must not trigger a full run (and a `process.exit`) just by importing.
if (/check-backup-coverage\.ts$/.test(process.argv[1] ?? '')) {
  main();
}

export { toCoverageKey, extractHostPathVolumes, uncoveredVolumes };
export type { TemplateVolume };
