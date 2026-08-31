/**
 * Assist catalog + secret-hygiene consistency suite.
 *
 *  1. Every built-in assist (`assists/*.md`) has valid frontmatter
 *     (title, whenToUse, kind ∈ ASSIST_KINDS) and a unique id.
 *  2. No committed template or assist contains a real secret. Templates express
 *     credentials as `type: "secret"` variables (the wizard injects the value at
 *     deploy); a literal key/token/password must never land in the repo. This is
 *     a backstop for known secret shapes — not a substitute for care.
 *  3. No agent-facing doc (root CLAUDE.md, assists, MCP tool descriptions) names
 *     an MCP tool that is no longer registered (#2382 — the #2324 consolidation
 *     hard-replaced 9 tool names and three live docs kept steering agents at the
 *     removed ones).
 *
 * Pure file-system + parsing. No agent / network needed.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { ASSIST_KINDS } from '@/lib/assists/catalog';
import { SECRET_PATTERNS } from '@/lib/assists/secretScan';
import { auditAssistCatalogSource } from '../../scripts/invariants/assistCatalogSingleSource';

/** Extract + parse the YAML frontmatter block from a markdown file. */
function frontmatter(raw: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return {};
  const parsed = yaml.load(m[1]);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ASSISTS_DIR = path.join(REPO_ROOT, 'assists');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

const TEXT_EXTS = new Set(['.md', '.yml', '.yaml', '.json', '.mustache', '.py', '.txt', '.env', '.sh']);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && TEXT_EXTS.has(path.extname(entry.name))) out.push(p);
  }
  return out;
}

// Secret signatures are factored into the shared runtime module
// `@/lib/assists/secretScan` (SECRET_PATTERNS) so this build-time backstop and
// the runtime landing gate (#2326 s4: proposals.ts `approveProposal`) can never
// drift — both scan with the SAME signatures.

describe('assist catalog frontmatter', () => {
  const files = fs.existsSync(ASSISTS_DIR)
    ? fs.readdirSync(ASSISTS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('.'))
    : [];

  it('has at least the seed entries', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every assist has valid frontmatter and a unique id', () => {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const f of files) {
      const id = f.slice(0, -'.md'.length);
      if (seen.has(id)) problems.push(`${f}: duplicate id`);
      seen.add(id);
      const d = frontmatter(fs.readFileSync(path.join(ASSISTS_DIR, f), 'utf-8'));
      const when = d.whenToUse ?? d.when_to_use;
      if (typeof d.title !== 'string' || !d.title.trim()) problems.push(`${f}: missing title`);
      if (typeof when !== 'string' || !String(when).trim()) problems.push(`${f}: missing whenToUse`);
      if (!(ASSIST_KINDS as readonly string[]).includes(d.kind as string)) {
        problems.push(`${f}: kind "${String(d.kind)}" not one of ${ASSIST_KINDS.join('|')}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// --- MCP tool-name drift (#2382) ---------------------------------------------
// Agent-facing prose that names a removed tool is worse than no prose: the agent
// gets tool-not-found on its first call and falls back to the destructive
// exec_command path the doc exists to steer it away from. The `lib/mcp/tools/`
// group modules are the source of truth for which names exist (#2384 moved the
// registrations there out of server.ts); these docs must only name those.
const MCP_TOOLS_DIR = path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib', 'mcp', 'tools');
const mcpToolSources = () =>
  fs.readdirSync(MCP_TOOLS_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => fs.readFileSync(path.join(MCP_TOOLS_DIR, f), 'utf-8'))
    .join('\n');

/** Tools removed by past consolidations whose verb prefix is also gone, so the
 *  heuristic below can't infer them (kept in sync with the OLD_NAMES list in
 *  packages/backend/src/lib/mcp/server.test.ts). */
const RETIRED_TOOLS = ['start_service', 'stop_service', 'restart_service'];

/** snake_case identifiers inside a `backtick span`, or anywhere in a description. */
function snakeTokens(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map(m => m[0]);
}

describe('MCP tool-name drift in agent-facing docs', () => {
  const src = mcpToolSources();
  const registered = new Set([...src.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]));
  // First segment of every registered name ("get", "list", "manage", …). A
  // `get_*`/`list_*` token that isn't registered is a stale tool name, not prose.
  const verbs = new Set([...registered].map(n => n.split('_')[0]));
  const isStale = (tok: string) =>
    !registered.has(tok) && (verbs.has(tok.split('_')[0]) || RETIRED_TOOLS.includes(tok));

  it('extracted the registered tool list from the tool-group modules', () => {
    expect(registered.size).toBeGreaterThan(40);
    expect(registered.has('get_logs')).toBe(true);
    // get_logs lives in logTools.ts and manage_service in serviceTools.ts, so
    // seeing both proves the scan really walks the whole directory rather than
    // one module (a single-file read would still clear the >40 bar).
    expect(registered.has('manage_service')).toBe(true);
  });

  it('CLAUDE.md and the assists only name registered MCP tools', () => {
    const docs = [
      path.join(REPO_ROOT, 'CLAUDE.md'),
      ...(fs.existsSync(ASSISTS_DIR)
        ? fs.readdirSync(ASSISTS_DIR).filter(f => f.endsWith('.md')).map(f => path.join(ASSISTS_DIR, f))
        : []),
    ].filter(f => fs.existsSync(f));
    const hits: string[] = [];
    for (const file of docs) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const span of text.matchAll(/`([^`\n]+)`/g)) {
        for (const tok of snakeTokens(span[1])) {
          if (isStale(tok)) hits.push(`${path.relative(REPO_ROOT, file)} — \`${tok}\` is not a registered MCP tool`);
        }
      }
    }
    expect([...new Set(hits)], `Stale MCP tool name(s) in agent-facing docs:\n${[...new Set(hits)].join('\n')}`).toEqual([]);
  });

  it('no MCP tool description points at a removed tool', () => {
    const hits: string[] = [];
    for (const m of src.matchAll(/server\.tool\(\s*'([a-z0-9_]+)',\s*'((?:[^'\\]|\\.)*)'/g)) {
      for (const tok of snakeTokens(m[2])) {
        if (isStale(tok)) hits.push(`${m[1]} description — \`${tok}\` is not a registered MCP tool`);
      }
    }
    expect([...new Set(hits)], `Stale MCP tool name(s) in tool descriptions:\n${[...new Set(hits)].join('\n')}`).toEqual([]);
  });
});

// --- ESLint sb/* rule-name drift (#2634) -------------------------------------
// The custom rules are the documented enforcement point for several
// architecture decisions, so the docs name them — and a name that no longer
// exists (or never did) fails silently in the direction that matters: a
// developer who writes `// eslint-disable-next-line sb/<wrong-name>` gets no
// "rule not found" error, the disable comment no-ops, and the real rule keeps
// firing. `docs/UX_DECISIONS.md` carried `sb/no-backend-from-frontend` for the
// rule actually called `sb/no-fe-backend-import` until #2634.
//
// eslint.config.mjs is the source of truth: a rule is usable under the `sb/`
// prefix iff the config registers it there.
const ESLINT_CONFIG = path.join(REPO_ROOT, 'eslint.config.mjs');
/** `sb/<rule>` occurrences, ignoring path segments like `tools/sb/internal`. */
const SB_RULE_RE = /(?<![\w/-])sb\/([a-z][a-z0-9-]*)/g;

describe('ESLint sb/* rule-name drift in docs', () => {
  const registered = new Set(
    [...fs.readFileSync(ESLINT_CONFIG, 'utf-8').matchAll(SB_RULE_RE)].map(m => m[1]),
  );

  it('extracted the registered sb/* rule names from eslint.config.mjs', () => {
    expect(registered.size).toBeGreaterThanOrEqual(5);
    expect(registered.has('no-fe-backend-import')).toBe(true);
    expect(registered.has('no-raw-color-literal')).toBe(true);
  });

  it('every sb/* rule the docs and assists name is registered', () => {
    const docFiles = [
      path.join(REPO_ROOT, 'CLAUDE.md'),
      path.join(TEMPLATES_DIR, 'CLAUDE.md'),
      ...walk(path.join(REPO_ROOT, 'docs')).filter(f => f.endsWith('.md')),
      ...walk(ASSISTS_DIR).filter(f => f.endsWith('.md')),
    ].filter(f => fs.existsSync(f));
    expect(docFiles.length).toBeGreaterThan(5);

    const hits: string[] = [];
    for (const file of docFiles) {
      for (const m of fs.readFileSync(file, 'utf-8').matchAll(SB_RULE_RE)) {
        if (!registered.has(m[1])) {
          hits.push(`${path.relative(REPO_ROOT, file)} — \`sb/${m[1]}\` is not a registered ESLint rule`);
        }
      }
    }
    expect(
      [...new Set(hits)],
      `Stale ESLint rule name(s) in docs:\n${[...new Set(hits)].join('\n')}\n`
      + `Registered: ${[...registered].map(r => `sb/${r}`).sort().join(', ')}`,
    ).toEqual([]);
  });
});

// #2701 / ADR 0014: the one-source condition the runtime-delivery decision hangs
// on, and the RED path of the gate that holds it — a gate whose failure branch is
// never exercised is a gate nobody knows still works.
describe('the assist catalog has exactly one source (#2701)', () => {
  it('passes on the real Dockerfile + loader', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf-8');
    const loader = fs.readFileSync(path.join(REPO_ROOT, 'packages/backend/src/lib/assists/catalog.ts'), 'utf-8');
    expect(auditAssistCatalogSource(dockerfile, loader)).toEqual([]);
  });

  it('fails when the image COPY comes back', () => {
    const problems = auditAssistCatalogSource(
      'FROM node\nCOPY --from=builder /app/assists ./assists\n',
      'const x = 1;',
    );
    expect(problems.join(' ')).toMatch(/copies the assist catalog into the image/);
  });

  it('fails when the loader grows a process.cwd() fallback again', () => {
    const problems = auditAssistCatalogSource(
      'FROM node\n',
      "const BUILTIN = () => path.join(process.cwd(), 'assists');",
    );
    expect(problems.join(' ')).toMatch(/process\.cwd\(\)/);
  });
});

describe('secret hygiene', () => {
  it('no committed template or assist contains a real secret', () => {
    const files = [...walk(ASSISTS_DIR), ...walk(TEMPLATES_DIR)];
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) hits.push(`${path.relative(REPO_ROOT, file)} — matches ${name}`);
      }
    }
    expect(hits, `Possible secret(s) committed:\n${hits.join('\n')}`).toEqual([]);
  });
});
