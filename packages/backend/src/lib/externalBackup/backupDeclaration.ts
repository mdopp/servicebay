/**
 * The PURE half of the backup bridge: a template's `servicebay.backup`
 * declaration → the runtime `ServiceBackupManifest`s the producer, the worker
 * and the restore path run (#2858, slice C). No fs, no config, no logger — so
 * `scripts/check-backup-coverage.ts` runs EXACTLY this code at build time and
 * the box runs it at backup time. A gate that asks a different question from
 * the runtime is the failure mode #2596 was.
 *
 * Before this module, "what counts as this service's config" could only be a
 * row in `SERVICE_BACKUP_MANIFESTS` — a table that lives inside ServiceBay, so
 * a template from another registry could not describe its own backup at all
 * (#2849) and simply was not backed up. Now the template says it, and this
 * module is the only place that turns what it said into what actually runs.
 *
 * THE TWO PLATFORM-ENFORCED LIMITS (ADR 0002). A template is data, and a
 * template from a foreign registry is less trusted than our own code, so
 * neither limit is left to the declaration:
 *
 *   1. **Path boundary** — every include/exclude/data/strip/transform path must
 *      resolve inside the service's own data dir. The parser refuses a whole
 *      declaration that breaks it; this module re-checks each path here, on the
 *      producer side, so a declaration that reached the runtime by another
 *      route (a hand-edited local template, a registry clone updated under us)
 *      still cannot walk out of the data dir. An offending path is DROPPED and
 *      reported with the reason — never silently honoured.
 *   2. **Tier clamp** — a bulk volume never goes to the NAS, whatever the
 *      template declares. `EXCLUDED_BULK_VOLUMES` is ServiceBay's own list of
 *      the multi-GB / regenerable / credential-coupled trees (media library,
 *      photo blobs, Postgres cluster dirs); an include path that lands inside
 *      one is dropped from `include`, pushed onto `exclude`, and reported. A
 *      template cannot talk the platform into pushing the household media
 *      library to a NAS share by declaring it as config.
 *
 * A store that loses its last include path to either clamp produces NO manifest
 * — a backup that would stage nothing must not exist, because an empty
 * manifest reports "0 files, ok" and looks exactly like a healthy run.
 */

import {
  dataDirEscapeReason,
  parseTemplateBackupYaml,
  type TemplateBackupStore,
} from '../template/backupContract';
import {
  EXCLUDED_BULK_VOLUMES,
  type BackupCollector,
  type ServiceBackupManifest,
} from '@servicebay/backup-manifest';

/** What one template's declaration resolved to. */
export interface TemplateBackupResolution {
  /** The manifests the template contributes — its own store first, then the
   *  `stores:` entries in declaration order. Empty for an opt-out. */
  manifests: ServiceBackupManifest[];
  /** The `backup: none` reason, when the template opted out explicitly. */
  optOut: string | null;
  /** Why the declaration was refused, or which paths the clamp dropped.
   *  Non-empty here is always a defect the operator/author must see. */
  problems: string[];
}

/** The DATA_DIR-relative roots that must never enter a NAS tarball. */
function bulkRoots(): string[] {
  return Object.keys(EXCLUDED_BULK_VOLUMES).map(k => k.replace(/\/+$/, ''));
}

function isUnder(key: string, roots: readonly string[]): boolean {
  return roots.some(root => key === root || key.startsWith(`${root}/`));
}

/** The declaration's collector spec → the runtime collector descriptor.
 *  `file` is the absence of a collector, which is what the manifest shape
 *  already means by an omitted `collector`. */
function toRuntimeCollector(spec: TemplateBackupStore['collector']): BackupCollector | undefined {
  if (spec.kind === 'file') return undefined;
  if (spec.kind === 'npm-sqlite') return { kind: 'npm-sqlite' };
  return {
    kind: 'pg-dump',
    container: spec.container,
    user: spec.user,
    database: spec.database,
    ...(spec.pgdata !== undefined ? { pgdata: spec.pgdata } : {}),
    ...(spec.dumpPath !== undefined ? { dumpPath: spec.dumpPath } : {}),
  };
}

/** Keep only the paths that stay inside the service's data dir; log the rest. */
function withinBoundary(
  paths: readonly string[],
  service: string,
  field: string,
  problems: string[],
): string[] {
  return paths.filter(p => {
    const reason = dataDirEscapeReason(p);
    if (!reason) return true;
    problems.push(
      `${service}: dropped ${field} path "${p}" — it ${reason} (ADR 0002 path boundary, re-checked producer-side).`,
    );
    return false;
  });
}

/**
 * Tier clamp, hostPath shape (ADR 0002): an include path that resolves inside
 * a volume ServiceBay itself calls bulk is dropped from `include` AND pushed
 * onto `exclude`, so nested staging can't reach it either. A template does not
 * get to push the household media library to a NAS share by calling it config.
 */
function clampBulk(
  include: readonly string[],
  service: string,
  store: TemplateBackupStore,
  roots: readonly string[],
  problems: string[],
): { kept: string[]; clamped: string[] } {
  if (store.volume !== undefined) return { kept: [...include], clamped: [] };
  const dataRoot = (store.dataSubdir ?? service).replace(/\/+$/, '');
  const kept: string[] = [];
  const clamped: string[] = [];
  for (const p of include) {
    const key = `${dataRoot}/${p.replace(/\/+$/, '')}`;
    if (!isUnder(key, roots)) {
      kept.push(p);
      continue;
    }
    clamped.push(p);
    problems.push(
      `${service}: clamped include "${p}" — it resolves into the bulk volume "${key}", which never ` +
      `enters a NAS tarball (ADR 0002 tier clamp).`,
    );
  }
  return { kept, clamped };
}

/** Refuse the whole store, with a reason, or `null` when it may proceed. */
function refuseStore(service: string, store: TemplateBackupStore, roots: readonly string[]): string | null {
  if (store.dataSubdir !== undefined && dataDirEscapeReason(store.dataSubdir)) {
    return `${service}: refused — dataSubdir "${store.dataSubdir}" leaves the data dir (ADR 0002).`;
  }
  // Tier clamp, volume shape: a named volume ServiceBay lists as bulk is never
  // pushed to the NAS, whatever the template says about it.
  if (store.volume !== undefined && roots.includes(store.volume)) {
    return (
      `${service}: refused — the podman volume "${store.volume}" is declared bulk in EXCLUDED_BULK_VOLUMES ` +
      `(${EXCLUDED_BULK_VOLUMES[store.volume]}), so it never goes to the NAS (ADR 0002 tier clamp).`
    );
  }
  return null;
}

/**
 * Apply both platform limits to one store and build its manifest, or return
 * `null` when nothing backup-worthy survives.
 */
function toManifest(
  service: string,
  gateOn: string | undefined,
  store: TemplateBackupStore,
  problems: string[],
): ServiceBackupManifest | null {
  const roots = bulkRoots();
  const refusal = refuseStore(service, store, roots);
  if (refusal) {
    problems.push(refusal);
    return null;
  }

  const { kept: include, clamped } = clampBulk(
    withinBoundary(store.include, service, 'include', problems),
    service, store, roots, problems,
  );
  if (include.length === 0) {
    problems.push(
      `${service}: no include path survived the ADR 0002 checks — no manifest built (an empty backup ` +
      `reports "ok" and is indistinguishable from a healthy one).`,
    );
    return null;
  }

  const exclude = withinBoundary(store.exclude, service, 'exclude', problems);
  const data = withinBoundary(store.data, service, 'data', problems);
  const strip = store.strip.filter(r => !dataDirEscapeReason(r.file));
  const transform = store.transform.filter(r => !dataDirEscapeReason(r.file));
  const collector = toRuntimeCollector(store.collector);
  return {
    service,
    ...(gateOn !== undefined ? { gateOn } : {}),
    ...(store.dataSubdir !== undefined ? { dataSubdir: store.dataSubdir } : {}),
    ...(store.volume !== undefined ? { volume: store.volume } : {}),
    include,
    exclude: [...exclude, ...clamped.filter(p => !exclude.includes(p))],
    ...(data.length > 0 ? { data } : {}),
    ...(strip.length > 0 ? { strip } : {}),
    ...(transform.length > 0 ? { transform } : {}),
    ...(collector !== undefined ? { collector } : {}),
  };
}

/**
 * Resolve ONE template's declaration. Pure over its inputs — the gate
 * (`scripts/check-backup-coverage.ts`) and the runtime read path share it, so
 * what CI checks is exactly what the box runs.
 *
 * `backupRaw` absent is a PROBLEM, not an opt-out: silence is
 * indistinguishable from an oversight, which is how three services sat
 * un-backed-up while the nightly run reported success (#2595).
 */
export function resolveTemplateBackupDeclaration(
  template: string,
  backupRaw: string | undefined,
): TemplateBackupResolution {
  if (backupRaw === undefined) {
    return {
      manifests: [],
      optOut: null,
      problems: [
        `${template}: no \`servicebay.backup\` annotation. Declare what to keep, or say ` +
        `\`backup: none\` with a \`reason:\` — silence is not an opt-out (#2858).`,
      ],
    };
  }
  const parsed = parseTemplateBackupYaml(backupRaw);
  if (!parsed.ok) {
    return {
      manifests: [],
      optOut: null,
      problems: parsed.errors.map(e => `${template}: servicebay.backup ${e}`),
    };
  }
  if (parsed.backup.kind === 'none') {
    return { manifests: [], optOut: parsed.backup.reason, problems: [] };
  }

  const { stores, ...own } = parsed.backup;
  const problems: string[] = [];
  const manifests: ServiceBackupManifest[] = [];
  if (own.include.length > 0) {
    const m = toManifest(template, undefined, own, problems);
    if (m) manifests.push(m);
  }
  for (const [service, store] of Object.entries(stores)) {
    const m = toManifest(service, template, store, problems);
    if (m) manifests.push(m);
  }
  return { manifests, optOut: null, problems };
}

