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
 * A template that owns MORE than one store — a multi-app template (`auth`
 * ships authelia + lldap), or one with a sibling dir installed under another
 * name (`home-assistant` carries the zwave-js key store) — declares the extras
 * under `stores:`, keyed by the store's own service name. Those are the old
 * table's `gateOn` rows: the declaring template is the gate.
 *
 * WHAT THIS MODULE IS NOT. It parses and validates the *declaration*; it does
 * not read it at backup time. The parse result is deliberately its own type
 * rather than `ServiceBackupManifest`: the manifest is the runtime shape (it
 * carries the `gateOn` wiring this parser derives and the collector-set
 * `renames`, neither of which a template may declare about itself). The bridge
 * — declaration → manifest, plus the platform-enforced ADR 0002 clamp — is
 * `lib/externalBackup/templateManifests.ts` (slice C).
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
type TemplateBackupCollectorSpec =
  | { kind: 'file' }
  | { kind: 'npm-sqlite' }
  | {
      kind: 'pg-dump';
      container: string;
      user: string;
      database: string;
      pgdata?: string;
      dumpPath?: string;
    };

/**
 * One backing store a template declares. Usually the template's own
 * (`servicebay.backup` top level); a multi-app template or one with a sibling
 * store declares the extras under `stores:` (see
 * {@link TemplateBackupDeclaration.stores}).
 */
export interface TemplateBackupStore {
  /** On-disk data subdir under DATA_DIR when it differs from the template
   *  name. Mutually exclusive with `volume`. */
  dataSubdir?: string;
  /** Podman-managed named volume holding the state instead of a DATA_DIR
   *  subdir (the `claimName` of a kube PVC). Mutually exclusive with
   *  `dataSubdir`; include paths are then relative to the volume root. */
  volume?: string;
  collector: TemplateBackupCollectorSpec;
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

/** A template that declares what to back up. */
interface TemplateBackupDeclaration extends TemplateBackupStore {
  kind: 'declared';
  /**
   * EXTRA stores this template owns that are installed under a DIFFERENT name
   * (#1594/#2595, the old table's `gateOn` entries). Two shapes, one mechanism:
   * a sibling dir of the template's own config (`home-assistant/zwave-js/`
   * beside `home-assistant/homeassistant/`), or one app of a multi-app template
   * (`authelia` and `lldap` are both apps of `auth`). The key is the store's
   * service name — what the tarball is called and what a restore asks for; the
   * template that declares it is the gate that activates it.
   *
   * A template with nothing of its own (`auth`, `media`) declares ONLY stores:
   * the top-level `include` is then empty and no own-store manifest is built.
   */
  stores: Record<string, TemplateBackupStore>;
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

/**
 * `collector:` accepts the bare name for the two collectors that need no
 * configuration, and the object form for `pg-dump`, which cannot run without
 * knowing the container/role/database to dump. A bare `collector: pg-dump` is
 * therefore refused: it names a collector that could never execute, and a
 * collector that silently does not run is the exact failure mode #2858 exists
 * to close.
 */
const collectorSchema = z.union([
  z.literal('file').transform(() => ({ kind: 'file' as const })),
  z.literal('npm-sqlite').transform(() => ({ kind: 'npm-sqlite' as const })),
  z.strictObject({ kind: z.literal('npm-sqlite') }),
  z.strictObject({
    kind: z.literal('pg-dump'),
    container: z.string().trim().min(1),
    user: z.string().trim().min(1),
    database: z.string().trim().min(1),
    pgdata: z.string().trim().min(1).optional(),
    dumpPath: z.string().trim().min(1).optional(),
  }),
]);

const storeSchema = z.strictObject({
  dataSubdir: z.string().trim().min(1).optional(),
  volume: z.string().trim().min(1).optional(),
  collector: collectorSchema.default({ kind: 'file' }),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  data: z.array(z.string()).default([]),
  strip: z
    .array(z.strictObject({ file: z.string(), dropYamlKeys: z.array(z.string()).min(1) }))
    .default([]),
  transform: z
    .array(z.strictObject({ file: z.string(), kind: z.literal('ha-config-entries-addon') }))
    .default([]),
});

/** Store names are tarball names and `installedTemplates`-adjacent service
 *  ids — a plain single segment, never a path. */
const storeNameSchema = z.string().regex(
  /^[a-z0-9][a-z0-9-]*$/,
  'must be a plain lowercase service name (letters, digits, hyphens)',
);

const declaredSchema = storeSchema.extend({
  stores: z.record(storeNameSchema, storeSchema).default({}),
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

/** Shape-check one store's paths + storage choice. `at` prefixes the field
 *  names so an error on a `stores:` entry names which entry it came from. */
function checkStore(store: TemplateBackupStore, at: string, errors: string[]): void {
  if (store.dataSubdir !== undefined && store.volume !== undefined) {
    errors.push(
      `${at}\`dataSubdir\` and \`volume\` are mutually exclusive — the state lives either `
      + 'in a DATA_DIR subdir or in a podman-managed named volume, not both.',
    );
  }
  if (store.dataSubdir !== undefined) {
    const reason = dataDirEscapeReason(store.dataSubdir);
    if (reason) errors.push(`${at}dataSubdir "${store.dataSubdir}" ${reason}.`);
  }
  checkPaths(store.include, `${at}include`, errors);
  checkPaths(store.exclude, `${at}exclude`, errors);
  checkPaths(store.data, `${at}data`, errors);
  checkPaths(store.strip.map(r => r.file), `${at}strip.file`, errors);
  checkPaths(store.transform.map(r => r.file), `${at}transform.file`, errors);
}

/** The declared branch: shape via zod, then the ADR 0002 path boundary. */
function parseDeclared(doc: unknown): ParseTemplateBackupResult {
  const parsed = declaredSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, errors: zodIssueMessages(parsed.error) };
  }
  const { stores, ...own } = parsed.data;

  const errors: string[] = [];
  // A declaration that names nothing at all is the silence the contract
  // exists to forbid: it is indistinguishable from an oversight, so say
  // `backup: none` (with a reason) instead of declaring an empty shell.
  if (own.include.length === 0 && Object.keys(stores).length === 0) {
    errors.push(
      'declares no `include` paths and no `stores:` — an empty declaration is '
      + 'indistinguishable from a forgotten one. Declare what to keep, or say '
      + '`backup: none` with a `reason:`.',
    );
  }
  checkStore(own, '', errors);
  for (const [name, store] of Object.entries(stores)) {
    if (store.include.length === 0) {
      errors.push(`stores.${name}: declares no \`include\` paths — drop the entry or give it one.`);
    }
    checkStore(store, `stores.${name}.`, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, backup: { kind: 'declared', ...own, stores } };
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
