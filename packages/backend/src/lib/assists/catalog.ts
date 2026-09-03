/**
 * Task-assist catalog (#2146).
 *
 * A small, extensible knowledge base an MCP agent can query for help on a
 * task: guides, ordered recipes, checklists, footguns, snippets. Two tools sit
 * on top of it — `list_assists` (discover) and `get_assist` (fetch) — keeping
 * the MCP tool surface tiny while the catalog grows over time.
 *
 * Sources — exactly ONE of them delivers the repo catalog (#2701):
 *   - Repo:     the runtime-delivered catalog, `delivery.ts:resolveCatalogDir()`.
 *     The repo's `assists/` tree is pulled onto the disk at runtime; it is NOT
 *     baked into the image any more, so a `docs(assists):` commit reaches a
 *     running box without waiting for an unrelated release. Served with the bare
 *     id `<stem>`, `source: 'Built-in'`. A delivery that has failed or aged out
 *     makes every read below throw `AssistCatalogUnavailableError` — empty and
 *     loud, never stale and quiet.
 *   - Local:    `DATA_DIR/local-assists/` — NOT a delivery path. It holds only
 *     what a ServiceBay admin approved through the assist editor (#2221). Such
 *     an entry still overrides the repo entry with the same id — that is what an
 *     override is for — but it can no longer do so quietly: it is served as
 *     `source: 'Local (overrides repo)'` and it is listed by `listAssistDrift()`
 *     as an override awaiting promotion or removal (#2701).
 *   - Landed:   `DATA_DIR/local-assists/landed/` — an ADDITIVE, NAMESPACED
 *     source (#2326 s4): an approved `propose_learning` proposal is written
 *     here and served under id `local/<stem>` with `source: Local`. It can
 *     NEVER shadow a built-in id (governance decision, epic #2326: additive-only
 *     namespaced ids — updating a built-in is a repo PR, never a silent runtime
 *     override by id). This is why landed proposals get their own subdir + id
 *     prefix rather than sharing the flat override space above.
 *
 * Each assist is a single markdown file with frontmatter:
 *
 *   ---
 *   title: Create & deploy a new ServiceBay service
 *   whenToUse: You need to build a new service repo and deploy it behind SSO.
 *   kind: recipe                 # guide | recipe | template | checklist | footgun | snippet
 *   tags: [service, template, deploy, subdomain, sso]
 *   ---
 *   <body markdown>
 *
 * The `id` is the filename without the `.md` extension.
 */

import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import { resolveCatalogDir } from '@/lib/assists/delivery';

export const ASSIST_KINDS = [
  'guide',
  'recipe',
  'adr',
  'template',
  'checklist',
  'footgun',
  'snippet',
] as const;

export type AssistKind = (typeof ASSIST_KINDS)[number];

export interface AssistSummary {
  id: string;
  title: string;
  /** One line telling the agent when this assist applies — drives self-selection. */
  whenToUse: string;
  kind: AssistKind;
  tags: string[];
  /** 'Built-in' (delivered repo catalog), 'Local', or `LOCAL_OVERRIDE_SOURCE`. */
  source: string;
}

// The runtime-delivered repo catalog (#2701), then the admin-approved override
// dir. Order matters: later sources override earlier ones by id. The namespaced
// landed dir (#2326 s4) is additive — its `local/` id prefix means it never
// collides with the two bare-id sources above.
//
// There is deliberately NO `process.cwd()/assists` fallback: the image does not
// carry the catalog, and a fallback would be the second source the #2701
// decision exists to prevent.
const LOCAL_ASSISTS_DIR = () => path.join(DATA_DIR, 'local-assists');
/** Additive, namespaced landing dir for approved proposals (#2326 s4). */
export const LANDED_ASSISTS_DIR = () => path.join(DATA_DIR, 'local-assists', 'landed');
/** Id prefix every landed (namespaced) assist carries. */
const LOCAL_ID_PREFIX = 'local/';

interface AssistSource {
  dir: string;
  source: string;
  /** Id prefix for entries from this dir (`''` = bare stem, `local/` = namespaced). */
  prefix: string;
}

/**
 * Label a Local bare-id entry carries once it shadows a delivered repo entry.
 * The override stays effective; it just stops being invisible (#2701).
 */
const LOCAL_OVERRIDE_SOURCE = 'Local (overrides repo)';

/**
 * Throws `AssistCatalogUnavailableError` when delivery has failed or aged out —
 * every read below goes through it, so a broken delivery can never present as
 * an empty catalog.
 */
async function assistSources(): Promise<AssistSource[]> {
  return [
    { dir: await resolveCatalogDir(), source: 'Built-in', prefix: '' },
    { dir: LOCAL_ASSISTS_DIR(), source: 'Local', prefix: '' },
    { dir: LANDED_ASSISTS_DIR(), source: 'Local', prefix: LOCAL_ID_PREFIX },
  ];
}

/**
 * Resolve a request-supplied assist id to the `<stem>.md` filename plus the
 * ordered list of candidate source dirs to try (first hit wins), or null if the
 * id is unsafe/unknown-shape. A `local/<stem>` id maps to the landed dir only; a
 * bare `<stem>` id maps to the bare-id sources with Local overriding Built-in.
 * The `<stem>` is basename-guarded so a read can never escape a source root
 * (path-injection barrier; CodeQL js/path-injection).
 */
async function resolveAssistFile(id: string): Promise<{ file: string; dirs: string[] } | null> {
  if (id.startsWith(LOCAL_ID_PREFIX)) {
    const stem = id.slice(LOCAL_ID_PREFIX.length);
    const file = assistFileName(stem);
    return file ? { file, dirs: [LANDED_ASSISTS_DIR()] } : null;
  }
  if (id.includes('/')) return null; // a bare id may not contain a path separator
  const file = assistFileName(id);
  if (!file) return null;
  // Bare-id sources: the admin-approved override wins over the delivered repo
  // entry, mirroring the list precedence.
  return { file, dirs: [LOCAL_ASSISTS_DIR(), await resolveCatalogDir()] };
}

/**
 * Collapse a request-supplied id to a single, self-contained filename and
 * reject traversal — only a plain `<id>.md` is ever joined onto a source root,
 * so a read can never escape it (path-injection guard; CodeQL js/path-injection).
 * Returns null for an unsafe id.
 */
function assistFileName(id: string): string | null {
  const segment = path.basename(id);
  if (
    !segment ||
    segment !== id ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0')
  ) {
    return null;
  }
  return `${segment}.md`;
}

/**
 * Raised when the catalog holds entries that DECLARE frontmatter and not one of
 * them parsed — i.e. the frontmatter parser itself is broken, not the files
 * (#2650). Callers get a hard error instead of a plausible-looking list of
 * metadata-less stubs.
 */
export class AssistCatalogParseError extends Error {
  constructor(degraded: number) {
    super(
      `Assist catalog frontmatter is unreadable: all ${degraded} entries with a frontmatter block failed to parse. ` +
      'The YAML parser behind gray-matter is broken in this build (see #2650) — every title/whenToUse/kind/tags would be empty. ' +
      'Refusing to serve a metadata-less catalog.',
    );
    this.name = 'AssistCatalogParseError';
  }
}

function coerceKind(value: unknown): AssistKind {
  return (ASSIST_KINDS as readonly string[]).includes(value as string)
    ? (value as AssistKind)
    : 'guide';
}

function coerceTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * True when the file opens with a `---` fence, i.e. it CLAIMS to carry
 * frontmatter. The distinction matters: a file with no fence legitimately has
 * no metadata, whereas a fenced file that yields nothing is a parse failure
 * wearing the same clothes (#2650).
 */
function declaresFrontmatter(raw: string): boolean {
  return /^\uFEFF?---\r?\n/.test(raw);
}

/** Outcome of parsing one assist file. `degraded` = its frontmatter is unreadable. */
interface ParsedAssist {
  summary: AssistSummary | null;
  degraded: boolean;
}

/**
 * Parse a raw assist file into its summary.
 *
 * Unreadable frontmatter is LOUD and never served (#2650): before this, a
 * `matter()` that returned an empty `data` — which is what a broken YAML engine
 * does, silently, without throwing — was indistinguishable from a file that
 * simply has no frontmatter, so the catalog happily listed every entry with
 * `title = id`, `whenToUse: ''`, `kind: 'guide'`, `tags: []` and nobody noticed
 * for weeks. A fenced file that parses to zero keys is now an ERROR and the
 * entry is dropped rather than published as a stub.
 */
function parseAssistSummary(raw: string, id: string, source: string): ParsedAssist {
  let data: Record<string, unknown>;
  try {
    // Pass an options object on purpose: it makes gray-matter skip `matter.cache`.
    // The cache stores the file object BEFORE parsing it, so once a parse throws,
    // every later read of the same content is served the cached, half-built object
    // with `data: {}` and NO error — the exact mechanism that turned a hard failure
    // into a silent one on the box (#2650).
    const parsed = matter(raw, {});
    data = (parsed.data ?? {}) as Record<string, unknown>;
  } catch (e) {
    logger.error('assists', `Assist "${id}" has unreadable frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return { summary: null, degraded: true };
  }

  if (declaresFrontmatter(raw) && Object.keys(data).length === 0) {
    logger.error(
      'assists',
      `Assist "${id}" declares a frontmatter block that parsed to nothing — the frontmatter parser is broken (#2650). ` +
      'Dropping the entry instead of serving it without title/whenToUse/kind/tags.',
    );
    return { summary: null, degraded: true };
  }

  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id;
  // Accept either camelCase or snake_case for the human-facing hint.
  const whenRaw = data.whenToUse ?? data.when_to_use ?? '';
  const whenToUse = typeof whenRaw === 'string' ? whenRaw.trim() : '';
  return {
    summary: { id, title, whenToUse, kind: coerceKind(data.kind), tags: coerceTags(data.tags), source },
    degraded: false,
  };
}

async function readDirAssists(dir: string): Promise<string[]> {
  try {
    await fs.access(dir);
  } catch {
    return []; // a missing source dir is a valid no-op
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch (e) {
    logger.error('assists', `Failed to scan assist dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Score an assist against free-text query tokens. 0 = no match. */
function scoreAssist(a: AssistSummary, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const hay = [a.id, a.title, a.whenToUse, a.kind, a.tags.join(' ')].join(' ').toLowerCase();
  let score = 0;
  for (const t of tokens) if (hay.includes(t)) score++;
  return score;
}

export interface ListAssistsOptions {
  /** Free-text task description; ranks + filters entries that match any token. */
  query?: string;
  /** Restrict to one kind. */
  kind?: AssistKind;
}

/**
 * List catalog entries, Local overriding Built-in by id. When `query` is set,
 * only matching entries are returned, best match first.
 */
export async function listAssists(opts: ListAssistsOptions = {}): Promise<AssistSummary[]> {
  const byId = new Map<string, AssistSummary>();
  let degraded = 0;
  for (const { dir, source, prefix } of await assistSources()) {
    for (const file of await readDirAssists(dir)) {
      const id = `${prefix}${file.slice(0, -'.md'.length)}`;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, file), 'utf-8');
      } catch {
        continue;
      }
      // A Local bare-id entry that lands on an id the delivered catalog already
      // holds is an OVERRIDE — say so in the source, so nobody reads a
      // hand-approved copy as the repo's current text (#2701).
      const overriding = source === 'Local' && prefix === '' && byId.has(id);
      const parsed = parseAssistSummary(raw, id, overriding ? LOCAL_OVERRIDE_SOURCE : source);
      if (parsed.degraded) degraded++;
      // later BARE source wins; namespaced ids never collide
      if (parsed.summary) byId.set(id, parsed.summary);
    }
  }

  // Systemic failure, not a bad file: entries declared frontmatter and NOT ONE
  // of them parsed. Serving [] here would read as "the catalog is empty" and be
  // just as quiet as the stub list it replaced, so this is a hard error (#2650).
  if (degraded > 0 && byId.size === 0) throw new AssistCatalogParseError(degraded);

  let entries = [...byId.values()];
  if (opts.kind) entries = entries.filter(e => e.kind === opts.kind);

  const tokens = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = entries
    .map(e => ({ e, score: scoreAssist(e, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title));
  return scored.map(x => x.e);
}

/**
 * List the ids of the BUILT-IN assists only (the shipped `assists/` dir), NOT
 * the Local drop-dir. Used by the learning-proposal id-governance (#2326) to
 * reject any proposed id that would SHADOW a built-in — proposals are additive
 * and namespaced (`local/<slug>`); updating a built-in is a repo PR, never a
 * silent runtime override by id.
 */
export async function listBuiltinAssistIds(): Promise<string[]> {
  const files = await readDirAssists(await resolveCatalogDir());
  return files.map(f => f.slice(0, -'.md'.length));
}

/**
 * Drift-report entry (#2326 s5): a landed local-assist that has no
 * corresponding built-in entry in `assists/`. These are the assists awaiting
 * promotion to a repo PR.
 */
export interface AssistDriftEntry {
  /** Namespaced id of the landed assist, e.g. `local/my-recipe`. */
  id: string;
  title: string;
  kind: AssistKind;
  whenToUse: string;
  tags: string[];
  /**
   * `landed` — an approved proposal that has no repo entry yet (the original
   * #2326 s5 promotion backlog). `override` — an admin-approved Local entry
   * that SHADOWS a delivered repo entry of the same id (#2701). The second kind
   * is the one that can answer wrongly, so it belongs on the same list.
   */
  relation: 'landed' | 'override';
  /**
   * Hint for the admin: opening a repo PR to add `assists/<slug>.md` promotes
   * this entry from runtime-only to built-in.
   */
  promotionHint: string;
}

/**
 * The runtime-vs-repo divergence report. Two kinds of entry, both read-only and
 * side-effect-free:
 *
 *  - `relation: 'landed'` (#2326 s5) — an approved proposal under
 *    `DATA_DIR/local-assists/landed/` whose bare slug has NO corresponding repo
 *    entry: the promotion backlog. Mapping: landed id `local/<slug>` ↔ repo id
 *    `<slug>`; a slug the repo already covers is omitted.
 *  - `relation: 'override'` (#2701) — an admin-approved bare-id entry under
 *    `DATA_DIR/local-assists/` that SHADOWS a delivered repo entry. Now that the
 *    repo catalog is delivered at runtime, an override is the only way two
 *    texts can answer to one id, so it is reported rather than left to age
 *    unnoticed.
 */
/** Parse one Local file into a summary, or null when it is unreadable/degraded. */
async function summariseLocal(dir: string, file: string, id: string): Promise<AssistSummary | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, file), 'utf-8');
  } catch {
    return null;
  }
  return parseAssistSummary(raw, id, 'Local').summary;
}

/**
 * Walk one Local dir and emit a drift entry per file that satisfies `include`.
 * `hint` gets the slug and the filename so each relation can say what to do.
 */
async function collectDrift(
  dir: string,
  relation: AssistDriftEntry['relation'],
  idFor: (slug: string) => string,
  include: (slug: string) => boolean,
  hint: (slug: string, file: string) => string,
): Promise<AssistDriftEntry[]> {
  const out: AssistDriftEntry[] = [];
  for (const file of await readDirAssists(dir)) {
    const slug = file.slice(0, -'.md'.length);
    if (!include(slug)) continue;
    const summary = await summariseLocal(dir, file, idFor(slug));
    if (!summary) continue;
    const { id, title, kind, whenToUse, tags } = summary;
    out.push({ id, title, kind, whenToUse, tags, relation, promotionHint: hint(slug, file) });
  }
  return out;
}

export async function listAssistDrift(): Promise<AssistDriftEntry[]> {
  const builtinSet = new Set(await listBuiltinAssistIds());

  const landed = await collectDrift(
    LANDED_ASSISTS_DIR(),
    'landed',
    slug => `${LOCAL_ID_PREFIX}${slug}`,
    // Only surface entries with no repo counterpart.
    slug => !builtinSet.has(slug),
    slug => `Open a repo PR adding assists/${slug}.md to promote this entry from runtime-only to built-in.`,
  );

  // #2701: a Local bare-id entry that shadows a delivered repo entry is the
  // second-source failure one level down — it answers instead of the repo text
  // and ages on its own. It cannot be silent, so it rides this same list.
  const overrides = await collectDrift(
    LOCAL_ASSISTS_DIR(),
    'override',
    slug => slug,
    slug => builtinSet.has(slug),
    (slug, file) =>
      `This Local entry SHADOWS the delivered repo assist "${slug}" — get_assist("${slug}") answers with this copy, not the repo's. ` +
      `Fold the change into assists/${slug}.md in a repo PR and delete DATA_DIR/local-assists/${file}, or keep it deliberately.`,
  );

  return [...landed, ...overrides];
}

/**
 * Return the full raw markdown (frontmatter + body) of one assist by id. A bare
 * `<stem>` id reads Local (drop-dir override) then Built-in; a `local/<stem>` id
 * reads the additive landed dir (#2326 s4). Returns null for an unknown/unsafe id.
 */
export async function getAssist(id: string): Promise<string | null> {
  const resolved = await resolveAssistFile(id);
  if (!resolved) return null;
  for (const dir of resolved.dirs) {
    try {
      return await fs.readFile(path.join(dir, resolved.file), 'utf-8');
    } catch {
      continue;
    }
  }
  return null;
}
