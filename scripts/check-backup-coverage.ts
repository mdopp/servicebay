/**
 * Backup-coverage contract (#2153).
 *
 * Every template that declares a PERSISTENT volume must either:
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
 * A hostPath volume is COVERED by a manifest when its `{{DATA_DIR}}`-relative
 * path equals or is nested under a manifest's data dir (`dataSubdir ?? service`)
 * — e.g. the `adguard/work` + `adguard/conf` volumes are both under the
 * `adguard` manifest, and `file-share/samba-private` is under `file-share`.
 * A PODMAN NAMED VOLUME (a `PersistentVolumeClaim`) is covered when a manifest
 * names its `claimName` in `volume` — volumes are atomic, so that match is
 * exact, not prefix-based.
 *
 * The REVERSE direction is checked too: every manifest entry must gate on a
 * template this repo ships ({@link unknownGateManifests}, #2595), and every
 * manifest `volume` must name a PVC some template actually declares
 * ({@link unknownVolumeManifests}, #2596) — a manifest pointing at a volume that
 * exists nowhere promises a backup that can never run.
 *
 * ── Why this scans the parsed YAML, not `hostPath:` lines (#2596) ────────────
 * The original scan grepped for `hostPath:` blocks. A template that kept its
 * real config in a `PersistentVolumeClaim` was therefore not "uncovered" — it
 * never reached the check at all, and the gate printed green having never looked
 * at it. That is the worst failure mode a gate has: reporting success about a
 * question it did not ask. `file-share`'s `syncthing-config` PVC (Syncthing's
 * device identity + folder shares) sat outside the contract that way.
 *
 * So the scan now ENUMERATES every entry of every Pod's `spec.volumes` and
 * classifies it by kind. A kind the gate does not know is an ERROR, not a skip;
 * a template.yml that fails to parse is an ERROR, not zero volumes. The set of
 * kinds that hold no persistent state is written down, with reasons, in
 * {@link EPHEMERAL_VOLUME_KINDS}. There is no path through this file where a
 * volume is dropped silently.
 *
 * Exits 0 (all covered) or 1 (an uncovered volume, an unclassifiable one, a
 * template that would not parse, or a manifest gate/volume that names nothing).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  SERVICE_BACKUP_MANIFESTS,
  EXCLUDED_BULK_VOLUMES,
  getBackupGate,
  type ServiceBackupManifest,
} from '../packages/backup-manifest/src/index.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

/** How a template asks for storage. Both kinds can hold persistent state. */
type VolumeKind = 'hostPath' | 'persistentVolumeClaim';

/** A persistent volume declared by a template. */
interface TemplateVolume {
  template: string;
  /** The pod volume's `name:` — what the operator sees in the template. */
  name: string;
  kind: VolumeKind;
  /** The raw declaration: a `path:` (`{{DATA_DIR}}/vaultwarden`) or a `claimName:`. */
  raw: string;
  /** Coverage key: `{{DATA_DIR}}`-relative subpath / bare `{{VAR}}` token / claim name. */
  key: string;
}

/** A `spec.volumes[]` entry the gate could not classify — always an error. */
interface UnclassifiedVolume {
  template: string;
  name: string;
  /** The key(s) found beside `name:`, i.e. the volume source the gate saw. */
  kind: string;
  reason: string;
}

/**
 * Volume kinds that CANNOT hold persistent state, each with the reason it is out
 * of the backup contract. This table is the ONLY way a volume kind leaves the
 * check — anything not listed here and not a {@link VolumeKind} is reported as
 * unclassified and fails the build. Adding a kind here is a deliberate,
 * reviewable act; forgetting to is a red gate, not a green one.
 */
const EPHEMERAL_VOLUME_KINDS: Readonly<Record<string, string>> = {
  emptyDir: 'pod-lifetime scratch — podman discards it when the pod is recreated, so there is no state to preserve.',
  configMap: 'rendered into the pod from template variables on every deploy — regenerable, not stored state.',
  secret: 'injected at deploy time from the wizard variables — never the durable copy of anything.',
  downwardAPI: 'pod metadata projected by podman at start — not stored state.',
};

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

/**
 * Mustache placeholder → a plain YAML-safe token, so a template.yml can be
 * PARSED without a variable view. `{{DATA_DIR}}/x` is not valid YAML (`{` opens
 * a flow mapping); `SBVAR_DATA_DIR/x` is an ordinary scalar. Section markers
 * (`{{#GPU}}` … `{{/GPU}}`) are dropped, which deliberately makes a conditional
 * volume ALWAYS visible to the gate — a volume that only some installs get is
 * still a volume that must be covered.
 */
const SCAN_VAR_PREFIX = 'SBVAR_';

function toScannableYaml(text: string): string {
  return text
    .replace(/\{\{[#^/!][^{}]*\}\}/g, '') // section open/close + mustache comments
    .replace(/\{\{\{?\s*([A-Za-z0-9_.]+)\s*\}?\}\}/g, `${SCAN_VAR_PREFIX}$1`);
}

/** Undo {@link toScannableYaml} on one scalar, so the coverage rules keep
 *  reading the template's own `{{VAR}}` spelling. */
function fromScanToken(raw: string): string {
  return raw.replace(new RegExp(`^${SCAN_VAR_PREFIX}([A-Za-z0-9_]+)`), '{{$1}}');
}

/** Thrown when a template.yml cannot be read as YAML — a hard gate failure,
 *  because an unparseable template contributes ZERO volumes to the scan. */
class TemplateScanError extends Error {}

interface ScanResult {
  volumes: TemplateVolume[];
  unclassified: UnclassifiedVolume[];
}

type YamlDoc = { kind?: unknown; spec?: { volumes?: unknown } } | null | undefined;

/** Who a volume entry is, before the gate knows what it holds. */
interface VolumeIdent {
  template: string;
  name: string;
  /** The source key(s) found beside `name:`, for the error message. */
  kind: string;
}

const asUnclassified = (id: VolumeIdent, reason: string): UnclassifiedVolume => ({ ...id, reason });

/** A `hostPath:` source → a coverage candidate, or null when the path is
 *  outside the contract (a device, `/run`, an in-pod mount). */
function readHostPathVolume(
  id: VolumeIdent,
  source: unknown,
): TemplateVolume | UnclassifiedVolume | null {
  const raw = (source as { path?: unknown } | undefined)?.path;
  if (typeof raw !== 'string') return asUnclassified(id, 'hostPath has no string `path:`');
  const spelled = fromScanToken(raw);
  const key = toCoverageKey(spelled);
  return key ? { template: id.template, name: id.name, kind: 'hostPath', raw: spelled, key } : null;
}

/** A `persistentVolumeClaim:` source → always a coverage candidate: a podman
 *  named volume exists to persist something. */
function readClaimVolume(id: VolumeIdent, source: unknown): TemplateVolume | UnclassifiedVolume {
  const claim = (source as { claimName?: unknown } | undefined)?.claimName;
  if (typeof claim !== 'string' || claim.length === 0) {
    return asUnclassified(id, 'persistentVolumeClaim has no string `claimName:`');
  }
  const spelled = fromScanToken(claim);
  return { template: id.template, name: id.name, kind: 'persistentVolumeClaim', raw: spelled, key: spelled };
}

/**
 * Classify ONE `spec.volumes[]` entry. Every entry lands in exactly one of three
 * buckets: a persistent volume the coverage rules must judge, an enumerated
 * stateless kind (`null` — dropped ON PURPOSE, with a reason on record in
 * {@link EPHEMERAL_VOLUME_KINDS}), or an {@link UnclassifiedVolume} the gate
 * refuses to guess about. There is deliberately no fourth, silent path.
 */
function classifyVolumeEntry(
  template: string,
  entry: Record<string, unknown>,
): TemplateVolume | UnclassifiedVolume | null {
  const fields = Object.keys(entry ?? {});
  const sources = fields.filter(k => k !== 'name');
  const id: VolumeIdent = {
    template,
    name: typeof entry?.name === 'string' ? entry.name : '(unnamed)',
    kind: sources.join('+') || '(none)',
  };

  if (sources.length !== 1) {
    return asUnclassified(id, sources.length === 0
      ? 'the volume declares no source at all'
      : 'the volume declares more than one source, so the gate cannot tell what it holds');
  }
  const source = sources[0];
  if (source === 'hostPath') return readHostPathVolume(id, entry.hostPath);
  if (source === 'persistentVolumeClaim') return readClaimVolume(id, entry.persistentVolumeClaim);
  // Enumerated-as-stateless, or an unknown kind the gate refuses to guess about.
  return source in EPHEMERAL_VOLUME_KINDS
    ? null
    : asUnclassified(id, 'unknown volume kind — the gate cannot tell whether it holds persistent state');
}

/**
 * Enumerate EVERY `spec.volumes[]` entry of every Pod in a template and split
 * them into the persistent ones (candidates for the coverage rules) and the ones
 * the gate cannot classify.
 */
function extractTemplateVolumes(template: string, yamlText: string): ScanResult {
  let docs: unknown[];
  try {
    docs = yaml.loadAll(toScannableYaml(yamlText));
  } catch (e) {
    throw new TemplateScanError(e instanceof Error ? e.message : String(e));
  }
  const pods = (docs as YamlDoc[]).filter(d => d && typeof d === 'object' && d.kind === 'Pod');
  if (pods.length === 0) {
    throw new TemplateScanError('no `kind: Pod` document — the gate would scan no volumes');
  }

  const volumes: TemplateVolume[] = [];
  const unclassified: UnclassifiedVolume[] = [];
  for (const pod of pods) {
    const declared = pod?.spec?.volumes;
    if (declared === undefined) continue; // a pod may legitimately mount nothing
    if (!Array.isArray(declared)) {
      throw new TemplateScanError('`spec.volumes` is not a list — cannot enumerate volumes');
    }
    for (const entry of declared as Record<string, unknown>[]) {
      const classified = classifyVolumeEntry(template, entry);
      if (!classified) continue;
      if ('reason' in classified) unclassified.push(classified);
      else volumes.push(classified);
    }
  }
  return { volumes, unclassified };
}

/** The `{{DATA_DIR}}`-relative data dir a manifest owns (dataSubdir ?? service).
 *  A volume-held manifest owns no DATA_DIR path at all, so it contributes none. */
function manifestDataDirs(): string[] {
  return SERVICE_BACKUP_MANIFESTS
    .filter(m => !m.volume)
    .map(m => (m.dataSubdir ?? m.service).replace(/\/+$/, ''));
}

/** The podman named volumes the manifests claim to back up (#2596). */
function manifestVolumeClaims(): string[] {
  return SERVICE_BACKUP_MANIFESTS.map(m => m.volume).filter((v): v is string => !!v);
}

/** Is `key` equal to, or nested under, any covered root in `roots`? */
function isUnder(key: string, roots: string[]): boolean {
  return roots.some(root => key === root || key.startsWith(root + '/'));
}

/**
 * The volumes that satisfy neither a manifest nor an explicit bulk-exclude.
 * Exported so the gate's own coverage decision is testable without the
 * filesystem (tests/scripts/gate-config-truth.test.ts).
 *
 * hostPath coverage is by PREFIX (a manifest's data dir covers everything under
 * it); named-volume coverage is EXACT — a volume is an atomic unit, and a
 * manifest for `foo-config` says nothing about `foo-data`.
 */
function uncoveredVolumes(vols: readonly TemplateVolume[]): TemplateVolume[] {
  const manifestRoots = manifestDataDirs();
  const excludedRoots = Object.keys(EXCLUDED_BULK_VOLUMES).map(k => k.replace(/\/+$/, ''));
  const claims = new Set(manifestVolumeClaims());
  return vols.filter(v =>
    v.kind === 'persistentVolumeClaim'
      ? !claims.has(v.key) && !excludedRoots.includes(v.key)
      : !isUnder(v.key, manifestRoots) && !isUnder(v.key, excludedRoots),
  );
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

/** A manifest entry pointing at a podman volume no template declares. */
interface UnknownVolume {
  service: string;
  volume: string;
}

/**
 * The same defect class as {@link unknownGateManifests}, one level down (#2596):
 * a manifest whose `volume` claim no template ships. The worker would mount
 * nothing, stage nothing, and report the service as "no config on disk yet" —
 * a promised backup that can never run, indistinguishable at runtime from a
 * service that simply hasn't been deployed. Only the repo knows the difference.
 *
 * Also rejects a manifest that sets BOTH `volume` and `dataSubdir`: the two name
 * different storage, and silently preferring one would make the other a lie.
 */
function unknownVolumeManifests(
  manifests: readonly ServiceBackupManifest[],
  claimNames: readonly string[],
): UnknownVolume[] {
  const known = new Set(claimNames);
  return manifests
    .filter(m => m.volume !== undefined && (!known.has(m.volume) || m.dataSubdir !== undefined))
    .map(m => ({ service: m.service, volume: m.volume as string }));
}

/** The names of the templates this repo ships (a dir with a `template.yml`). */
function shippedTemplateNames(): string[] {
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => existsSync(path.join(TEMPLATES_DIR, name, 'template.yml')));
}

/** Report one gate failure — header, the offending rows, then the how-to-fix
 *  hints — and exit non-zero. Never returns. */
function fail(header: string, rows: string[], hints: string[]): never {
  console.error(`${header}\n`);
  for (const row of rows) console.error(`  ${row}`);
  console.error('');
  for (const hint of hints) console.error(hint);
  process.exit(1);
}

/** Scan every shipped template, keeping the ones that would not parse — an
 *  unreadable template must FAIL the gate, not quietly contribute no volumes. */
function scanAllTemplates(templates: readonly string[]): ScanResult & {
  unreadable: { template: string; message: string }[];
} {
  const volumes: TemplateVolume[] = [];
  const unclassified: UnclassifiedVolume[] = [];
  const unreadable: { template: string; message: string }[] = [];
  for (const template of templates) {
    try {
      const scan = extractTemplateVolumes(
        template,
        readFileSync(path.join(TEMPLATES_DIR, template, 'template.yml'), 'utf8'),
      );
      volumes.push(...scan.volumes);
      unclassified.push(...scan.unclassified);
    } catch (e) {
      unreadable.push({ template, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { volumes, unclassified, unreadable };
}

/** Fail on anything the SCAN itself could not do: a template that would not
 *  parse, or a volume whose kind the gate cannot classify. Both used to be
 *  invisible — the whole point of #2596. */
function reportScanProblems(
  unreadable: { template: string; message: string }[],
  unclassified: UnclassifiedVolume[],
): void {
  if (unreadable.length > 0) {
    fail(
      '✗ backup-coverage: template(s) the gate could not scan — an unscannable template contributes ZERO volumes, so this must fail rather than pass:',
      unreadable.map(u => `${u.template}: ${u.message}`),
      [
        'The gate parses template.yml with the mustache placeholders swapped for plain tokens',
        '(toScannableYaml in scripts/check-backup-coverage.ts). If a new placeholder shape broke that,',
        'fix the swap — do not let the template drop out of the scan.',
      ],
    );
  }

  if (unclassified.length > 0) {
    fail(
      '✗ backup-coverage (#2596): volume(s) the gate cannot classify. A volume kind it does not understand might hold real state, so it is an error, never a skip:',
      unclassified.map(u => `${u.template}: volume "${u.name}" (${u.kind}) — ${u.reason}`),
      [
        'If the kind genuinely cannot hold persistent state, add it to EPHEMERAL_VOLUME_KINDS in',
        'scripts/check-backup-coverage.ts WITH the reason. Otherwise teach the scan to read it and',
        'cover it with a manifest entry or an EXCLUDED_BULK_VOLUMES marker.',
      ],
    );
  }
}

/** Fail on a manifest that points at nothing: a gate naming no template (#2595)
 *  or a `volume` naming no declared claim (#2596). Both promise a backup that
 *  can never run, and both look healthy at runtime. */
function reportManifestProblems(templates: readonly string[], all: readonly TemplateVolume[]): void {
  const unknownGates = unknownGateManifests(SERVICE_BACKUP_MANIFESTS, templates);
  if (unknownGates.length > 0) {
    fail(
      '✗ backup-coverage contract (#2595): manifest entr(ies) gating on a name no template has — permanently inactive, so the backup they promise never runs:',
      unknownGates.map(g => {
        const source = g.explicit ? `gateOn: '${g.gate}'` : `service: '${g.gate}' (no gateOn)`;
        return `${g.service}: ${source} — no templates/${g.gate}/template.yml`;
      }),
      [
        'This is NOT the same as "the template is not installed on this box" — that is fine and expected.',
        'A gate that matches no template can never activate anywhere. Fix it by setting `gateOn` to the',
        'template that owns the data dir (an app of a multi-app template gates on the template, e.g.',
        "jellyfin → 'media', authelia/lldap → 'auth'), or by deleting the entry if the service is retired.",
        'There is ONE copy since #2733: packages/backup-manifest/src/index.ts, imported by both the',
        'backend and the sandboxed backup worker.',
      ],
    );
  }

  const declaredClaims = all.filter(v => v.kind === 'persistentVolumeClaim').map(v => v.key);
  const unknownVolumes = unknownVolumeManifests(SERVICE_BACKUP_MANIFESTS, declaredClaims);
  if (unknownVolumes.length > 0) {
    fail(
      "✗ backup-coverage contract (#2596): manifest entr(ies) whose `volume` names no PersistentVolumeClaim any template declares (or that set `volume` AND `dataSubdir`):",
      unknownVolumes.map(v => `${v.service}: volume: '${v.volume}'`),
      [
        'A volume claim no template creates is never mounted into the backup worker, so the entry stages',
        'nothing while looking healthy. Point `volume` at a claimName a template ships, or drop the entry.',
        '`volume` and `dataSubdir` are mutually exclusive — a manifest reads ONE storage location.',
      ],
    );
  }
}

/** The core #2153 contract: every persistent volume is covered or excused. */
function reportUncovered(all: readonly TemplateVolume[]): void {
  const uncovered = uncoveredVolumes(all);
  if (uncovered.length > 0) {
    fail(
      '✗ backup-coverage contract (#2153): persistent volume(s) with no manifest entry and no EXCLUDED_BULK_VOLUMES marker:',
      uncovered.map(v =>
        `${v.template}: ${v.kind === 'persistentVolumeClaim' ? `podman volume ${v.raw}` : v.raw}`,
      ),
      [
        'Add a SERVICE_BACKUP_MANIFESTS entry for it, or list it in EXCLUDED_BULK_VOLUMES with a reason.',
        'Both live in packages/backup-manifest/src/index.ts — the one copy the backend and the worker share.',
        'A PersistentVolumeClaim is covered by a manifest that sets `volume: <claimName>` (#2596) — the',
        'worker then reads it from the named volume servicebay binds in read-only.',
        'If a bare `{{VAR}}` hostPath is genuinely not stored state (a device, a socket), add a',
        'pattern + reason to NON_VOLUME_HOSTPATH_VARS in scripts/check-backup-coverage.ts (#2465).',
      ],
    );
  }
}

function main(): void {
  const templates = shippedTemplateNames();

  // Fail closed: an empty template list would make EVERY check vacuously green.
  if (templates.length === 0) {
    console.error('✗ backup-coverage: no templates found under templates/ — the gate would scan nothing.');
    process.exit(1);
  }

  const { volumes: all, unclassified, unreadable } = scanAllTemplates(templates);
  reportScanProblems(unreadable, unclassified);
  reportManifestProblems(templates, all);
  reportUncovered(all);

  const hostPaths = all.filter(v => v.kind === 'hostPath').length;
  const claims = all.length - hostPaths;
  console.log(`✓ backup-coverage: ${all.length} persistent template volume(s) all covered (manifest or explicit bulk-exclude) — ${hostPaths} hostPath, ${claims} podman named volume.`);
  console.log(`✓ backup-gates: ${SERVICE_BACKUP_MANIFESTS.length} manifest entr(ies) all gate on a shipped template, and every \`volume\` names a declared claim.`);
}

// Run only when invoked as the CLI — the pure helpers are imported by
// tests/scripts/gate-config-truth.test.ts, which must not trigger a full run
// (and a `process.exit`) just by importing.
if (/check-backup-coverage\.ts$/.test(process.argv[1] ?? '')) {
  main();
}

export {
  toCoverageKey,
  toScannableYaml,
  extractTemplateVolumes,
  uncoveredVolumes,
  unknownGateManifests,
  unknownVolumeManifests,
  shippedTemplateNames,
  TemplateScanError,
  EPHEMERAL_VOLUME_KINDS,
};
export type { TemplateVolume, UnclassifiedVolume, UnknownGate, UnknownVolume, ScanResult };
