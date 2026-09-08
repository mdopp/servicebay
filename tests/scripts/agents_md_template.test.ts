/**
 * The delivered `AGENTS.md` template (#2909, slice 4 of #2903).
 *
 * The kit ships ONE orientation file that serves both agents: pi reads
 * `AGENTS.md`/`CLAUDE.md` from `~/.pi/agent/`, the cwd and every directory
 * between, and concatenates the matches; Claude Code reads `CLAUDE.md`. A
 * container links this one file into both places instead of copying it, which
 * is why "is it delivered?" and "does it still describe the CLI?" are the two
 * things that can rot — and the two things this file pins:
 *
 *   1. **It rides the delivery.** The template is inside `AGENT_KIT_SUBDIRS`
 *      and listed in `AGENT_KIT_REQUIRED_FILES`, so a sparse set that stopped
 *      matching, or a file that moved, is a FAILED delivery rather than a kit
 *      that mounts fine and is missing the half nobody looked at. The copy-out
 *      below is the same stand-in `agent_cli_delivery.test.ts` uses: the sparse
 *      set, copied out of the repo, and nothing else.
 *   2. **Its verb section matches the real verb table.** Same class-level idea
 *      as `agent_cli_route_contract.test.ts`: no hand-picked list, it iterates
 *      `VERBS` from `agent-cli/servicebay.mjs`, so a NEW verb is covered the
 *      moment it is added and cannot go silently undocumented — and a
 *      documented option the CLI does not accept fails the same way, because
 *      the pinned string is the verb's own `usage`.
 *
 * Plus the two things a delivered document must never carry: a box-specific
 * value (a host, a LAN address, a domain) or a secret. It is a template for
 * every box, not a transcript of one.
 *
 * What is NOT provable here, by ADR 0014: that the file is readable at the
 * delivered path on the running box. That is the box-verify criterion — an
 * in-process check of the loader is exactly the substitution #2701 was.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AGENT_KIT_SUBDIRS, AGENT_KIT_REQUIRED_FILES } from '../../packages/backend/src/lib/assists/delivery';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_REL = 'agent-docs/AGENTS.md';
const CLI_PATH = path.join(REPO_ROOT, 'agent-cli', 'servicebay.mjs');

type Verb = { usage: string; summary: string };
const { VERBS } = (await import(CLI_PATH)) as { VERBS: Record<string, Verb> };

/** The marker that opens the pinned table, so the parse cannot drift onto another one. */
const TABLE_MARKER = '<!-- verb-table:';

/** A stand-in for what the box has after a successful sync: the sparse set, and nothing else. */
let kit: string;

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

beforeAll(() => {
  kit = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agents-md-'));
  for (const sub of AGENT_KIT_SUBDIRS) copyDir(path.join(REPO_ROOT, sub), path.join(kit, sub));
});

afterAll(() => {
  fs.rmSync(kit, { recursive: true, force: true });
});

/**
 * The first column of the pinned table, in order. Kept pure so the negative
 * control below can feed it a deliberately broken document.
 */
function documentedVerbCommands(markdown: string): string[] {
  const start = markdown.indexOf(TABLE_MARKER);
  if (start < 0) return [];
  const rows: string[] = [];
  for (const raw of markdown.slice(start).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      // The table ends at the first non-row line after it has begun.
      if (rows.length > 0) break;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    if (/^-+:?$|^:?-+/.test(cells[0])) continue; // the `| --- |` separator
    rows.push(cells[0]);
  }
  // Drop the header row (`Command`), which is not a command.
  return rows.filter(c => c.startsWith('`'));
}

/** The same table's second column, so an entry cannot be listed with no explanation. */
function documentedDescriptions(markdown: string): string[] {
  const start = markdown.indexOf(TABLE_MARKER);
  if (start < 0) return [];
  const out: string[] = [];
  for (const raw of markdown.slice(start).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (out.length > 0) break;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2 || /^-+:?$|^:?-+/.test(cells[0]) || !cells[0].startsWith('`')) continue;
    out.push(cells[1]);
  }
  return out;
}

/** What the table must say, derived from the CLI itself — never a hand-kept list. */
const expectedCommands = Object.values(VERBS).map(v => `\`servicebay ${v.usage}\``);

describe('the AGENTS.md template rides the delivered kit (#2909)', () => {
  it('is declared as a required file of the kit, not an optional extra', () => {
    expect([...AGENT_KIT_REQUIRED_FILES]).toContain(TEMPLATE_REL);
  });

  it('sits in a directory the one sparse-checkout set carries', () => {
    expect([...AGENT_KIT_SUBDIRS]).toContain(path.dirname(TEMPLATE_REL));
  });

  it('lands in a checkout made from that sparse set — no separate delivery', () => {
    expect(fs.existsSync(path.join(kit, TEMPLATE_REL))).toBe(true);
    // It lands beside the two halves it documents, under the one mountable root.
    expect(fs.existsSync(path.join(kit, 'agent-cli', 'servicebay.mjs'))).toBe(true);
    expect(fs.readdirSync(path.join(kit, 'assists')).filter(f => f.endsWith('.md')).length).toBeGreaterThan(0);
  });

  it('is the only AGENTS.md in the repo — one file, maintained in one place', () => {
    // Index + untracked-but-not-ignored, so a second copy fails here before it
    // is ever committed rather than one commit later.
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).split('\n');
    expect(tracked.filter(f => path.basename(f) === 'AGENTS.md')).toEqual([TEMPLATE_REL]);
  });
});

describe('its CLI section matches the real verb table', () => {
  const markdown = () => fs.readFileSync(path.join(kit, TEMPLATE_REL), 'utf-8');

  it('has verbs to check (a table that emptied itself is a red, not a pass)', () => {
    expect(expectedCommands.length).toBeGreaterThan(0);
    expect(documentedVerbCommands(markdown()).length).toBeGreaterThan(0);
  });

  it('documents every verb, with the CLI’s own usage string and nothing invented', () => {
    expect(
      documentedVerbCommands(markdown()),
      'The verb table in agent-docs/AGENTS.md no longer matches VERBS in agent-cli/servicebay.mjs. A new verb ' +
        'must be listed there (an undocumented verb is an unusable one), a removed verb must go, and each row’s ' +
        'command must be the verb’s own `usage` — a flag the CLI does not accept is worse than a missing row.',
    ).toEqual(expectedCommands);
  });

  it('explains each verb rather than only naming it', () => {
    const descriptions = documentedDescriptions(markdown());
    expect(descriptions).toHaveLength(expectedCommands.length);
    for (const text of descriptions) expect(text.length).toBeGreaterThan(10);
  });
});

describe('it says what an agent needs to start, and stays honest about the token', () => {
  const markdown = () => fs.readFileSync(path.join(kit, TEMPLATE_REL), 'utf-8');

  // The acceptance list from #2909: start point, verbs, test path, rollout
  // path, catalog path. Pinned as headings so dropping one is a red, not a
  // quietly shorter document.
  it.each([
    ['start point', /^## Where you start$/m],
    ['the CLI', /^## The CLI: reading the box from a shell$/m],
    ['what the read-scoped token cannot do', /^## What your token can and cannot do$/m],
    ['how it tests', /^## How you test$/m],
    ['how it rolls out', /^## How a change rolls out$/m],
    ['the delivered catalog path', /^## The assist catalog — read it, do not re-derive it$/m],
  ])('names %s', (_what, heading) => {
    expect(markdown()).toMatch(heading);
  });

  it('points at the catalog by its delivered path, not by a copy of its content', () => {
    expect(markdown()).toContain('$SERVICEBAY_AGENT_KIT/assists');
  });

  it('is explicit that the token cannot change anything on the box', () => {
    const text = markdown();
    expect(text).toMatch(/read-scoped/);
    expect(text).toMatch(/\*\*It cannot\*\*/);
  });

  it('tells the container to link the file rather than copy it', () => {
    expect(markdown()).toMatch(/ln -sfn/);
  });
});

describe('it is a template for every box: no box-specific value, no secret', () => {
  const text = () => fs.readFileSync(path.join(kit, TEMPLATE_REL), 'utf-8');

  it('carries no IP address — a reinstall or a new LAN address must not break it', () => {
    expect(text().match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []).toEqual([]);
  });

  it('carries no concrete host or deployment domain', () => {
    expect(text().match(/\b[\w-]+\.(?:cloud|lan|local|home)\b/g) ?? []).toEqual([]);
  });

  it('carries no token-shaped literal', () => {
    expect(text().match(/sb_[A-Za-z0-9_-]{8,}/g) ?? []).toEqual([]);
  });
});

describe('the check itself goes red on a drifted document (negative control)', () => {
  const table = ['x', TABLE_MARKER + ' -->', '', '| Command | What it does |', '| --- | --- |'];

  it('a table that lost a verb', () => {
    const doc = [...table, ...expectedCommands.slice(1).map(c => `| ${c} | does a thing |`), ''].join('\n');
    // Length first: a parse that silently returned nothing would satisfy the
    // inequality below without checking anything.
    expect(documentedVerbCommands(doc)).toHaveLength(expectedCommands.length - 1);
    expect(documentedVerbCommands(doc)).not.toEqual(expectedCommands);
  });

  it('a table that invented an option the CLI does not accept', () => {
    const invented = expectedCommands.map((c, i) => (i === 0 ? c.replace(/`$/, ' --since 1h`') : c));
    const doc = [...table, ...invented.map(c => `| ${c} | does a thing |`), ''].join('\n');
    expect(documentedVerbCommands(doc)).toHaveLength(expectedCommands.length);
    expect(documentedVerbCommands(doc)).not.toEqual(expectedCommands);
  });

  it('a document with no verb table at all', () => {
    expect(documentedVerbCommands('# Just a heading\n\nno table here.\n')).toEqual([]);
  });

  it('the real document is not passing by parsing to an empty list', () => {
    expect(documentedVerbCommands(fs.readFileSync(path.join(kit, TEMPLATE_REL), 'utf-8'))).toEqual(expectedCommands);
  });
});
