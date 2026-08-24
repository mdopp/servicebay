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
 * The REVERSE direction (#2595) is checked too: every manifest entry must gate
 * on a template this repo ships. See {@link unknownGateManifests}.
 *
 * Exits 0 (all covered) or 1 (an uncovered volume, or a gate that names no
 * template).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  SERVICE_BACKUP_MANIFESTS,
  EXCLUDED_BULK_VOLUMES,
  getBackupGate,
  type ServiceBackupManifest,
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

/** A manifest entry whose activation key names no shipped template. */
interface UnknownGate {
  service: string;
  gate: string;
  /** True when the gate came from `gateOn` rather than defaulting to `service`. */
  explicit: boolean;
}

/**
 * The reverse of the volume check (#2595). A manifest entry activates when
 * `getBackupGate(m)` — `gateOn ?? service` — is a key in `installedTemplates`,
 * i.e. a template NAME. Two situations look identical at runtime and are not:
 *
 *   - the gate names a real template that this box has not installed → the entry
 *     is correctly dormant. Normal, expected, nothing to report.
 *   - the gate names something no template is ever called → the entry is
 *     PERMANENTLY dormant on every box, and the backup it promises silently does
 *     not exist. That is always a defect.
 *
 * Only a repo-level check can tell the two apart, because only here is the full
 * set of template names known; at runtime the backup selector just sees a key
 * that is absent and moves on — which is exactly how `authelia`, `lldap` and
 * `jellyfin` sat un-backed-up while the nightly run reported "8/8 services
 * backed up" against a denominator that had quietly shrunk.
 *
 * Pure over its inputs so the gate's own decision is testable without the
 * filesystem (tests/scripts/gate-config-truth.test.ts).
 */
function unknownGateManifests(
  manifests: readonly ServiceBackupManifest[],
  templateNames: readonly string[],
): UnknownGate[] {
  const known = new Set(templateNames);
  return manifests
    .filter(m => !known.has(getBackupGate(m)))
    .map(m => ({ service: m.service, gate: getBackupGate(m), explicit: m.gateOn !== undefined }));
}

/** The names of the templates this repo ships (a dir with a `template.yml`). */
function shippedTemplateNames(): string[] {
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => existsSync(path.join(TEMPLATES_DIR, name, 'template.yml')));
}

function main(): void {
  const templates = shippedTemplateNames();

  const all: TemplateVolume[] = [];
  for (const template of templates) {
    all.push(
      ...extractHostPathVolumes(
        template,
        readFileSync(path.join(TEMPLATES_DIR, template, 'template.yml'), 'utf8'),
      ),
    );
  }

  const checked = all.length;
  const uncovered = uncoveredVolumes(all);

  // Fail closed: an empty template list would make BOTH checks vacuously green.
  if (templates.length === 0) {
    console.error('✗ backup-coverage: no templates found under templates/ — the gate would scan nothing.');
    process.exit(1);
  }

  const unknownGates = unknownGateManifests(SERVICE_BACKUP_MANIFESTS, templates);
  if (unknownGates.length > 0) {
    console.error('✗ backup-coverage contract (#2595): manifest entr(ies) gating on a name no template has — permanently inactive, so the backup they promise never runs:\n');
    for (const g of unknownGates) {
      const source = g.explicit ? `gateOn: '${g.gate}'` : `service: '${g.gate}' (no gateOn)`;
      console.error(`  ${g.service}: ${source} — no templates/${g.gate}/template.yml`);
    }
    console.error('\nThis is NOT the same as "the template is not installed on this box" — that is fine and expected.');
    console.error('A gate that matches no template can never activate anywhere. Fix it by setting `gateOn` to the');
    console.error('template that owns the data dir (an app of a multi-app template gates on the template, e.g.');
    console.error("jellyfin → 'media', authelia/lldap → 'auth'), or by deleting the entry if the service is retired.");
    console.error('Both copies must change: packages/backend/src/lib/externalBackup/serviceManifest.ts and the');
    console.error('packages/backup-worker/src/engine/serviceManifest.ts mirror.');
    process.exit(1);
  }

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
  console.log(`✓ backup-gates: ${SERVICE_BACKUP_MANIFESTS.length} manifest entr(ies) all gate on a shipped template.`);
}

// Run only when invoked as the CLI — `toCoverageKey` / `extractHostPathVolumes`
// / `uncoveredVolumes` / `unknownGateManifests` are imported by
// tests/scripts/gate-config-truth.test.ts, which must not trigger a full run
// (and a `process.exit`) just by importing.
if (/check-backup-coverage\.ts$/.test(process.argv[1] ?? '')) {
  main();
}

export {
  toCoverageKey,
  extractHostPathVolumes,
  uncoveredVolumes,
  unknownGateManifests,
  shippedTemplateNames,
};
export type { TemplateVolume, UnknownGate };
