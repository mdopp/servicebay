/**
 * Box-Verify LIGHT/FULL classifier (#2825).
 *
 * Step 0 of `.claude/skills/autoloop-issues/stages/box-verify.md` decides
 * whether a merged diff needs the expensive FULL path (`:dev` flip → verify →
 * flip back, ~15–28 min) or the LIGHT path (scratch `nginx -t` + `:latest`
 * probes, ~2–3 min). That decision used to be prose an agent re-derived each
 * run, with `templates/**` sitting in the render-only allowlist wholesale —
 * which is how PR #2823 (a `templates/claude-dev` schema v3→v4 bump) was
 * classified LIGHT and then could not verify a single acceptance criterion:
 * templates ship *inside* the app image (`Dockerfile: COPY templates ./templates`,
 * `registry.ts TEMPLATES_PATH`), so on `:latest` the new schema version simply
 * does not exist yet and `POST /napi/services/<name>/upgrade` answers
 * `applied:false, reason:"no template upgrade pending"`. The verify was
 * circular: the release was gated on it, and it needed the release.
 *
 * So the discriminator is not "does this file live under `templates/`" but
 * "is the change *upgrade-observable*":
 *   - a rendered manifest/asset edit for an already-installed schema version is
 *     observable on `:latest`             → LIGHT
 *   - a `servicebay.schema-version` bump, a new/changed `migrations/*` script,
 *     a container added to the pod, or a whole new template only exists in the
 *     `:dev` image                        → FULL
 *
 * Deterministic → a script (CLAUDE.md): the agent calls this and quotes the
 * verdict instead of re-reading an allowlist and guessing.
 *
 *   tsx scripts/autoloop-verify-classify.ts <base>..<head>
 *   tsx scripts/autoloop-verify-classify.ts <base> [<head>]     # head defaults to HEAD
 *
 * Emits one machine-readable last line:
 *   AUTOLOOP_VERIFY_CLASS {"path":"full","reasons":["templates/x/template.yml: …"],
 *                          "files":{"full":[…],"light":[…],"ignored":[…]}}
 *
 * `path` has THREE outcomes (#2829):
 *   full   at least one file needs the `:dev` flip
 *   light  nothing needs the flip, but something is observable on `:latest`
 *   none   nothing box-observable changed AT ALL — every file landed in
 *          `ignored` (playbooks/docs/scripts/tests, release-please noise, a
 *          `package.json` change confined to `scripts`/`devDependencies`).
 *          The orchestrator clears the verify gate on this without dispatching
 *          Box-Verify (SKILL.md Step 1 rule 1).
 *
 * The verdict is on the JSON line, never in the exit code: exit 0 for ALL THREE
 * outcomes, exit 2 on a setup error (bad revs / not a git tree). A `none` is a
 * successful classification, not a failure, so callers must read `path`.
 * `node:` builtins only — it runs from a bare checkout, before any build, and
 * reads *two git revisions* of a template rather than the installed one, so it
 * deliberately does not import the backend's manifest parser.
 */

import { execFileSync } from 'node:child_process';

export type VerifyPath = 'none' | 'light' | 'full';

export interface ChangedFile {
  /** `git diff --name-status` letter: A(dded) M(odified) D(eleted) R(enamed)… */
  status: string;
  /** repo-relative path (post-rename) */
  path: string;
  /** file content at the base rev — `null` when the file did not exist there */
  before?: string | null;
  /** file content at the head rev — `null` when the file was deleted */
  after?: string | null;
}

export interface Classification {
  /** `full` if any file forces the flip, else `light` if anything is
   *  box-observable at all, else `none` (everything was ignored). */
  path: VerifyPath;
  /** one `<path>: <why>` line per file that forced FULL (empty ⇒ LIGHT/NONE) */
  reasons: string[];
  files: { full: string[]; light: string[]; ignored: string[] };
}

/**
 * Files whose change cannot alter how the box handles a request at all —
 * playbooks, docs, CI config, the test/script trees. They never force a FULL
 * path and they never make a diff LIGHT-worthy on their own.
 */
const NOT_BOX_OBSERVABLE: RegExp[] = [
  /^\.claude\//,
  /^\.github\//,
  /^\.husky\//,
  /^docs\//,
  /^assists\//,
  /^scripts\//,
  /^tests\//,
  /\.md$/,
  /(^|\/)[^/]*\.test\.tsx?$/,
  /(^|\/)[^/]*\.spec\.tsx?$/,
];

/**
 * Release-please's own output. A version bump is *what the release is* — it can
 * never be the reason to verify that release. (`CHANGELOG.md` already matches
 * the `.md$` rule above; it is named here for the reader, not for the match.)
 */
const RELEASE_NOISE: RegExp[] = [/^\.release-please-manifest\.json$/, /(^|\/)CHANGELOG\.md$/];

/** Any workspace's `package.json`. */
const PACKAGE_JSON = /(^|\/)package\.json$/;

/**
 * `package.json` top-level keys whose change cannot alter how the box handles a
 * request: npm scripts and dev-only dependencies (neither is installed in the
 * runtime image) plus release-please's `version` bump. Adding an
 * `"autoloop:classify"` script used to classify FULL and cost a ~25 min `:dev`
 * flip (#2829). A `dependencies` / `engines` / `workspaces` change is real
 * runtime surface and still falls through to FULL.
 */
const PACKAGE_JSON_INERT_KEYS = new Set(['scripts', 'devDependencies', 'version']);

/**
 * Render-only modules: the proxy/portal config comes out different, the running
 * app handles requests identically. Mirrors box-verify.md's allowlist.
 */
const RENDER_ONLY: RegExp[] = [
  /^packages\/backend\/src\/lib\/stackInstall\/forwardAuth\.ts$/,
  /^packages\/backend\/src\/lib\/portal\/provisioner\.ts$/,
];

/** App request-path modules — any of these is FULL by itself. */
const APP_REQUEST_PATH: RegExp[] = [
  /^packages\/frontend\/src\/proxy\.ts$/,
  /^packages\/frontend\/src\/app\/.*\/route\.ts$/,
  /^packages\/backend\/src\/lib\/api\//,
  /^packages\/backend\/src\/lib\/auth\//,
  /^packages\/backend\/src\/lib\/install\//,
  /^packages\/backend\/src\/lib\/config\.ts$/,
];

const TEMPLATE_MANIFEST = /^templates\/[^/]+\/template\.ya?ml$/;
const TEMPLATE_MIGRATION = /^templates\/[^/]+\/migrations\//;
const TEMPLATE_ANY = /^templates\//;

function matchesAny(path: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(path));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '').trim();
  return trimmed.replace(/^["'](.*)["']$/, '$1');
}

/**
 * `metadata.annotations['servicebay.schema-version']`, defaulting to 1 exactly
 * like `parseTemplateSchemaVersion` in the backend (a template that never
 * versioned itself is v1).
 */
export function parseSchemaVersion(yamlText: string | null | undefined): number {
  if (!yamlText) return 1;
  const m = /^\s*servicebay\.schema-version:\s*(.+)$/m.exec(yamlText);
  if (!m) return 1;
  const n = Number.parseInt(stripQuotes(m[1]), 10);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Container names declared under `spec.containers` / `spec.initContainers`.
 *
 * Deliberately indentation-aware rather than a bare `- name:` grep: `volumes:`
 * entries and every `env:` entry inside a container are also `- name:` items,
 * so a naive grep reports a "new container" on every added environment
 * variable.
 */
export function parsePodContainerNames(yamlText: string | null | undefined): string[] {
  if (!yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^(\s*)(?:init)?[Cc]ontainers:\s*$/.exec(lines[i]);
    if (key) names.push(...containerNamesInBlock(lines, i + 1, key[1].length));
  }
  return names;
}

/** The `- name:` items of ONE list block, ignoring anything nested inside them. */
function containerNamesInBlock(lines: string[], start: number, keyIndent: number): string[] {
  const names: string[] = [];
  let itemIndent: number | null = null;
  let pending = -1;
  for (let j = start; j < lines.length; j++) {
    const line = lines[j];
    if (/^\s*(#.*)?$/.test(line)) continue; // blank / comment
    const indent = line.length - line.trimStart().length;
    const isItem = /^\s*-\s/.test(line);
    if (itemIndent === null) {
      if (!isItem || indent < keyIndent) break; // empty list, or straight to the next key
      itemIndent = indent;
    }
    // Dedented out of the list, or a sibling key at list level (`volumes:`).
    if (indent < itemIndent || (indent === itemIndent && !isItem)) break;
    if (indent > itemIndent) {
      if (pending >= 0 && indent === itemIndent + 2) pending = adoptNestedName(names, pending, line);
      continue;
    }
    const inline = /^\s*-\s*name:\s*(.+)$/.exec(line);
    if (inline) {
      names.push(stripQuotes(inline[1]));
      pending = -1;
      continue;
    }
    pending = names.push(`<unnamed container ${names.length + 1}>`) - 1;
  }
  return names;
}

/** `name:` on a line *after* the dash — fills in the placeholder, if it is one. */
function adoptNestedName(names: string[], pending: number, line: string): number {
  const nested = /^\s*name:\s*(.+)$/.exec(line);
  if (!nested) return pending;
  names[pending] = stripQuotes(nested[1]);
  return -1;
}

/** The top-level keys whose value differs between two JSON documents, or `null`
 *  when either side does not parse as a JSON object (⇒ no opinion). */
function changedTopLevelKeys(before: string, after: string): string[] | null {
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * Is this `package.json` diff confined to the inert keys? Conservative by
 * construction: an added/deleted file, an unreadable revision or a document that
 * does not parse all answer `false`, which sends the file down the normal
 * "if in doubt, go FULL" path.
 */
export function packageJsonChangeIsInert(before: string | null | undefined, after: string | null | undefined): boolean {
  if (before == null || after == null) return false;
  const changedKeys = changedTopLevelKeys(before, after);
  if (changedKeys === null) return false;
  return changedKeys.every(k => PACKAGE_JSON_INERT_KEYS.has(k));
}

/**
 * FULL-or-LIGHT for a single `templates/**` file. Returns `null` for "no
 * opinion" (the caller treats it as LIGHT-eligible).
 */
export function classifyTemplateFile(file: ChangedFile): string | null {
  if (TEMPLATE_MIGRATION.test(file.path)) {
    return 'template migration script — it only ever runs during an upgrade against the :dev image';
  }
  if (!TEMPLATE_MANIFEST.test(file.path)) return null;
  if (file.status.startsWith('D')) return null; // a removed template can't be upgrade-verified
  const before = file.before ?? null;
  if (before === null) {
    return 'new template manifest — it does not exist in the :latest image, so nothing can install it there';
  }
  const beforeVersion = parseSchemaVersion(before);
  const afterVersion = parseSchemaVersion(file.after);
  if (beforeVersion !== afterVersion) {
    return `servicebay.schema-version ${beforeVersion} → ${afterVersion} — the upgrade only exists in the :dev image`;
  }
  const beforeContainers = parsePodContainerNames(before);
  const afterContainers = parsePodContainerNames(file.after);
  const added = afterContainers.filter(n => !beforeContainers.includes(n));
  if (added.length > 0) {
    return `container(s) added to the pod: ${added.join(', ')} — a new container only starts from the :dev image`;
  }
  return null;
}

/** The whole verdict for a diff. FULL wins over LIGHT, LIGHT over NONE; unknown
 *  paths are FULL. NONE means every file was ignored — there is nothing on the
 *  box to look at, so the gate clears without a Box-Verify dispatch (#2829). */
export function classifyChanges(changes: ChangedFile[]): Classification {
  const files: Classification['files'] = { full: [], light: [], ignored: [] };
  const reasons: string[] = [];

  const record = (file: ChangedFile, reason: string | null, bucket: keyof Classification['files']) => {
    files[bucket].push(file.path);
    if (reason) reasons.push(`${file.path}: ${reason}`);
  };

  for (const file of changes) {
    if (matchesAny(file.path, NOT_BOX_OBSERVABLE) || matchesAny(file.path, RELEASE_NOISE)) {
      record(file, null, 'ignored');
      continue;
    }
    if (PACKAGE_JSON.test(file.path) && packageJsonChangeIsInert(file.before, file.after)) {
      record(file, null, 'ignored');
      continue;
    }
    if (matchesAny(file.path, APP_REQUEST_PATH)) {
      record(file, 'app request-path module', 'full');
      continue;
    }
    if (TEMPLATE_ANY.test(file.path)) {
      const reason = classifyTemplateFile(file);
      if (reason) record(file, reason, 'full');
      else record(file, null, 'light');
      continue;
    }
    if (matchesAny(file.path, RENDER_ONLY)) {
      record(file, null, 'light');
      continue;
    }
    // Everything else: box-verify.md's "if in doubt, go FULL".
    record(file, 'not on the render-only allowlist', 'full');
  }

  const path: VerifyPath = files.full.length > 0 ? 'full' : files.light.length > 0 ? 'light' : 'none';
  return { path, reasons, files };
}

// ---------------------------------------------------------------- git plumbing

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function showOrNull(rev: string, path: string, cwd: string): string | null {
  try {
    return git(['show', `${rev}:${path}`], cwd);
  } catch {
    return null; // absent at that revision
  }
}

export function collectChangedFiles(base: string, head: string, cwd = process.cwd()): ChangedFile[] {
  const out = git(['diff', '--name-status', '-M', base, head], cwd);
  const changes: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const path = parts[parts.length - 1];
    const file: ChangedFile = { status, path };
    // Content is only needed to tell a schema/container change from a render
    // edit, and an inert `package.json` key change from a real one — don't pay
    // for `git show` on anything else.
    if (TEMPLATE_MANIFEST.test(path) || PACKAGE_JSON.test(path)) {
      file.before = status.startsWith('A') ? null : showOrNull(base, parts[1], cwd);
      file.after = status.startsWith('D') ? null : showOrNull(head, path, cwd);
    }
    changes.push(file);
  }
  return changes;
}

export function parseRange(argv: string[]): { base: string; head: string } | null {
  const args = argv.filter(a => !a.startsWith('-'));
  if (args.length === 0) return null;
  if (args[0].includes('..')) {
    const [base, head] = args[0].split('..');
    if (!base) return null;
    return { base, head: head || 'HEAD' };
  }
  return { base: args[0], head: args[1] ?? 'HEAD' };
}

export function formatVerdict(result: Classification): string {
  return `AUTOLOOP_VERIFY_CLASS ${JSON.stringify(result)}`;
}

function main(): void {
  const range = parseRange(process.argv.slice(2));
  if (!range) {
    console.error('usage: tsx scripts/autoloop-verify-classify.ts <base>..<head> | <base> [<head>]');
    process.exit(2);
  }
  let changes: ChangedFile[];
  try {
    changes = collectChangedFiles(range.base, range.head);
  } catch (err) {
    console.error(`autoloop-verify-classify: cannot diff ${range.base}..${range.head}: ${(err as Error).message}`);
    process.exit(2);
  }
  const result = classifyChanges(changes);
  const verdict = result.path === 'none' ? 'NONE — nothing box-observable changed' : `${result.path.toUpperCase()} path`;
  console.log(`${range.base}..${range.head}: ${changes.length} changed file(s) → ${verdict}`);
  for (const reason of result.reasons) console.log(`  FULL because ${reason}`);
  console.log(formatVerdict(result));
}

const invokedDirectly = process.argv[1] && /autoloop-verify-classify\.ts$/.test(process.argv[1]);
if (invokedDirectly) main();
