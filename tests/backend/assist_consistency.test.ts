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
// exec_command path the doc exists to steer it away from. server.ts is the
// source of truth for which names exist; these docs must only name those.
const MCP_SERVER = path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib', 'mcp', 'server.ts');

/** Tools removed by past consolidations whose verb prefix is also gone, so the
 *  heuristic below can't infer them (kept in sync with the OLD_NAMES list in
 *  packages/backend/src/lib/mcp/server.test.ts). */
const RETIRED_TOOLS = ['start_service', 'stop_service', 'restart_service'];

/** snake_case identifiers inside a `backtick span`, or anywhere in a description. */
function snakeTokens(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map(m => m[0]);
}

describe('MCP tool-name drift in agent-facing docs', () => {
  const src = fs.readFileSync(MCP_SERVER, 'utf-8');
  const registered = new Set([...src.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]));
  // First segment of every registered name ("get", "list", "manage", …). A
  // `get_*`/`list_*` token that isn't registered is a stale tool name, not prose.
  const verbs = new Set([...registered].map(n => n.split('_')[0]));
  const isStale = (tok: string) =>
    !registered.has(tok) && (verbs.has(tok.split('_')[0]) || RETIRED_TOOLS.includes(tok));

  it('extracted the registered tool list from server.ts', () => {
    expect(registered.size).toBeGreaterThan(40);
    expect(registered.has('get_logs')).toBe(true);
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
