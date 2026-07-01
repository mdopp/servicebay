/**
 * Task-assist catalog (#2146).
 *
 * A small, extensible knowledge base an MCP agent can query for help on a
 * task: guides, ordered recipes, checklists, footguns, snippets. Two tools sit
 * on top of it — `list_assists` (discover) and `get_assist` (fetch) — keeping
 * the MCP tool surface tiny while the catalog grows over time.
 *
 * Sources, mirroring the template registry's multi-source + local-drop shape:
 *   - Built-in: the repo-root `assists/` dir, shipped into the container image
 *     (`process.cwd()` is `/app` at runtime, so this resolves to `/app/assists`).
 *   - Local:    `DATA_DIR/local-assists/` — a persisted drop dir so an operator
 *     (or an agent, once write access exists) can add an assist WITHOUT a
 *     release. A Local entry with the same id overrides the built-in one.
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
  /** 'Built-in' or 'Local'. */
  source: string;
}

// Repo-root `assists/` (shipped to /app/assists in the container), then the
// persisted drop dir. Order matters: later sources override earlier ones by id.
const BUILTIN_ASSISTS_DIR = () => path.join(process.cwd(), 'assists');
const LOCAL_ASSISTS_DIR = () => path.join(DATA_DIR, 'local-assists');

function assistSources(): { dir: string; source: string }[] {
  return [
    { dir: BUILTIN_ASSISTS_DIR(), source: 'Built-in' },
    { dir: LOCAL_ASSISTS_DIR(), source: 'Local' },
  ];
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

/** Parse a raw assist file into its summary. Returns null on unreadable frontmatter. */
function parseAssistSummary(raw: string, id: string, source: string): AssistSummary | null {
  try {
    const { data } = matter(raw);
    const d = data as Record<string, unknown>;
    const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : id;
    // Accept either camelCase or snake_case for the human-facing hint.
    const whenRaw = d.whenToUse ?? d.when_to_use ?? '';
    const whenToUse = typeof whenRaw === 'string' ? whenRaw.trim() : '';
    return { id, title, whenToUse, kind: coerceKind(d.kind), tags: coerceTags(d.tags), source };
  } catch (e) {
    logger.warn('assists', `Skipping unparseable assist "${id}": ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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
  for (const { dir, source } of assistSources()) {
    for (const file of await readDirAssists(dir)) {
      const id = file.slice(0, -'.md'.length);
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, file), 'utf-8');
      } catch {
        continue;
      }
      const summary = parseAssistSummary(raw, id, source);
      if (summary) byId.set(id, summary); // later source wins
    }
  }

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
 * Return the full raw markdown (frontmatter + body) of one assist, Local
 * overriding Built-in. Returns null for an unknown or unsafe id.
 */
export async function getAssist(id: string): Promise<string | null> {
  const file = assistFileName(id);
  if (!file) return null;
  // Local first so a drop-in override wins, mirroring registry precedence.
  for (const { dir } of [...assistSources()].reverse()) {
    try {
      return await fs.readFile(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
  }
  return null;
}
