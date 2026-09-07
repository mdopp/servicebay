/**
 * `servicebay.backup` annotation parser — the template-facing half of the
 * backup contract (#2858, slice A).
 *
 * Until this existed, "what counts as this service's config" lived ONLY in
 * `SERVICE_BACKUP_MANIFESTS` (`packages/backup-manifest`), a table inside
 * ServiceBay. That was fine while every template lived in `templates/`, but a
 * template from another registry cannot add a row to a table it doesn't ship
 * (#2849). So the declaration moves onto the template:
 *
 *   metadata:
 *     annotations:
 *       servicebay.backup: |
 *         dataSubdir: nginx-proxy-manager
 *         collector: npm-sqlite
 *         include:
 *           - data/database.sqlite
 *         exclude:
 *           - data/logs
 *
 * A template with nothing worth preserving says so explicitly — silence is
 * never an opt-out, because silence is indistinguishable from an oversight:
 *
 *   servicebay.backup: |
 *     backup: none
 *     reason: Stateless proxy — every file is re-rendered on deploy.
 *
 * WHAT THIS MODULE IS NOT. It parses and validates the *declaration*; it does
 * not read it at backup time. The producer/worker read path, the `pg-dump`
 * collector and the migration of the built-in templates are the epic's later
 * slices. The parse result is deliberately its own type rather than
 * `ServiceBackupManifest`: the manifest is the runtime shape (it carries
 * `gateOn` sibling-store wiring and collector-set `renames`, neither of which
 * a template may declare about itself), and slice C owns the bridge.
 *
 * PLATFORM-ENFORCED LIMIT (ADR 0002). A foreign template is less trusted than
 * our own code, so the path boundary is enforced here, at parse time, and not
 * left to the producer: every `include`/`exclude`/`data` path must resolve
 * INSIDE the service's own data dir. Absolute paths, `~`, any `..` segment and
 * unresolved `{{MUSTACHE}}` placeholders (which we cannot check statically —
 * they could expand into an escape at deploy time) are rejected with a reason
 * naming the offending path, so the caller logs *why* the declaration was
 * refused instead of silently backing up the wrong tree.
 *
 * Pure function — no fs / Node deps, same as the rest of `contract.ts`.
 */
import yaml from 'js-yaml';
import { z } from 'zod';

/**
 * How the producer reads the service's state before staging it.
 * - `file` (default): plain file copy of the include paths.
 * - `npm-sqlite`: in-container `sqlite3 .backup` first — a live WAL-mode
 *   database that a plain `cp` would tear.
 * - `pg-dump`: `pg_dump` inside the service's own Postgres container, staged
 *   as a normal include (the collector itself is slice B).
 */
const TEMPLATE_BACKUP_COLLECTORS = ['file', 'npm-sqlite', 'pg-dump'] as const;
type TemplateBackupCollector = (typeof TEMPLATE_BACKUP_COLLECTORS)[number];

/** A template that declares what to back up. */
interface TemplateBackupDeclaration {
  kind: 'declared';
  /** On-disk data subdir under DATA_DIR when it differs from the template
   *  name. Mutually exclusive with `volume`. */
  dataSubdir?: string;
  /** Podman-managed named volume holding the state instead of a DATA_DIR
   *  subdir (the `claimName` of a kube PVC). Mutually exclusive with
   *  `dataSubdir`; include paths are then relative to the volume root. */
  volume?: string;
  collector: TemplateBackupCollector;
  /** Paths worth preserving across a reinstall (ADR 0002 tier A). */
  include: string[];
  /** Paths that must never enter the tarball — bulk, logs, caches. */
  exclude: string[];
  /** Large on-RAID artifacts kept through a `wipe-config` reinstall
   *  (ADR 0002 tier B). Declarative; never backed up. */
  data: string[];
  /** Per-file YAML key removals applied as a file enters the tarball. */
  strip: { file: string; dropYamlKeys: string[] }[];
  /** Per-file value rewrites applied as a file enters the tarball. */
  transform: { file: string; kind: 'ha-config-entries-addon' }[];
}

/** A template that declares it has nothing to back up, and why. */
interface TemplateBackupNone {
  kind: 'none';
  reason: string;
}

type TemplateBackup = TemplateBackupDeclaration | TemplateBackupNone;

export type ParseTemplateBackupResult =
  | { ok: true; backup: TemplateBackup }
  | { ok: false; errors: string[] };

const noneSchema = z.strictObject({
  backup: z.literal('none'),
  reason: z.string().trim().min(1),
});

const declaredSchema = z.strictObject({
  dataSubdir: z.string().trim().min(1).optional(),
  volume: z.string().trim().min(1).optional(),
  collector: z.enum(TEMPLATE_BACKUP_COLLECTORS).default('file'),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).default([]),
  data: z.array(z.string()).default([]),
  strip: z
    .array(z.strictObject({ file: z.string(), dropYamlKeys: z.array(z.string()).min(1) }))
    .default([]),
  transform: z
    .array(z.strictObject({ file: z.string(), kind: z.literal('ha-config-entries-addon') }))
    .default([]),
});

/**
 * Why a declared path does NOT resolve inside the service's own data dir, or
 * `null` when it does. Exported so the producer (slice C) enforces the same
 * boundary on a declaration that reached it by another route.
 */
export function dataDirEscapeReason(rawPath: string): string | null {
  if (typeof rawPath !== 'string') return 'is not a string';
  const p = rawPath.trim();
  if (p === '' || p === '.') return 'is empty';
  if (p.includes('\0')) return 'contains a NUL byte';
  if (p.includes('{{')) {
    return 'contains a `{{…}}` placeholder — backup paths are relative to the '
      + 'service data dir and must be literal, so the boundary can be checked here';
  }
  if (p.startsWith('/') || p.startsWith('\\')) return 'is absolute';
  if (p.startsWith('~')) return 'is home-relative (`~`)';
  const segments = p.split('/');
  if (segments.some(s => s === '..')) {
    return 'contains a `..` segment, which leaves the service data dir';
  }
  return null;
}

function checkPaths(
  values: readonly string[],
  field: string,
  errors: string[],
): void {
  values.forEach((value, i) => {
    const reason = dataDirEscapeReason(value);
    if (reason) {
      errors.push(
        `${field}[${i}] "${value}" ${reason}. Every backup path must resolve inside the `
        + `service's own data dir (ADR 0002).`,
      );
    }
  });
}

function zodIssueMessages(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${at}: ${issue.message}`;
  });
}

/** The `backup: none` opt-out branch — recognised by its discriminator so a
 *  typo'd field on a real declaration cannot silently degrade into "this
 *  service has no state". */
function parseNoneOptOut(doc: unknown): ParseTemplateBackupResult {
  const parsed = noneSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        'declares `backup:` but is not a valid opt-out. The only accepted form is '
        + '`backup: none` together with a non-empty `reason:` saying why this service '
        + 'has nothing worth preserving.',
        ...zodIssueMessages(parsed.error),
      ],
    };
  }
  return { ok: true, backup: { kind: 'none', reason: parsed.data.reason.trim() } };
}

/** The declared branch: shape via zod, then the ADR 0002 path boundary. */
function parseDeclared(doc: unknown): ParseTemplateBackupResult {
  const parsed = declaredSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, errors: zodIssueMessages(parsed.error) };
  }
  const d = parsed.data;

  const errors: string[] = [];
  if (d.dataSubdir !== undefined && d.volume !== undefined) {
    errors.push(
      '`dataSubdir` and `volume` are mutually exclusive — the state lives either '
      + 'in a DATA_DIR subdir or in a podman-managed named volume, not both.',
    );
  }
  if (d.dataSubdir !== undefined) {
    const reason = dataDirEscapeReason(d.dataSubdir);
    if (reason) errors.push(`dataSubdir "${d.dataSubdir}" ${reason}.`);
  }
  checkPaths(d.include, 'include', errors);
  checkPaths(d.exclude, 'exclude', errors);
  checkPaths(d.data, 'data', errors);
  checkPaths(d.strip.map(r => r.file), 'strip.file', errors);
  checkPaths(d.transform.map(r => r.file), 'transform.file', errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    backup: {
      kind: 'declared',
      dataSubdir: d.dataSubdir,
      volume: d.volume,
      collector: d.collector,
      include: d.include,
      exclude: d.exclude,
      data: d.data,
      strip: d.strip,
      transform: d.transform,
    },
  };
}

/**
 * Parse the body of a `servicebay.backup` block scalar. Returns the parsed
 * declaration or the list of reasons it was refused.
 */
export function parseTemplateBackupYaml(raw: string): ParseTemplateBackupResult {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return { ok: false, errors: [`is not valid YAML: ${(e as Error).message}`] };
  }
  if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      ok: false,
      errors: [
        'must be a YAML mapping — either the backup fields (`include:` …) or '
        + '`backup: none` with a `reason:`.',
      ],
    };
  }
  return 'backup' in (doc as Record<string, unknown>)
    ? parseNoneOptOut(doc)
    : parseDeclared(doc);
}
