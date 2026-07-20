/**
 * Frontend copy-paste / duplicate-JSX report (#2354).
 *
 * "You can only reuse what you can find" has a sibling: you can only extract
 * what you can *see*. This flags near-identical blocks in
 * `packages/frontend/src` — the "same Card rendered 5× inline" smell — as
 * extraction candidates, so a duplicated surface becomes a nudge toward a
 * `components/ui` primitive instead of silent drift.
 *
 * WHY A SCRIPT, NOT jscpd: CLAUDE.md's house pattern is `tsx scripts/*.ts`,
 * node: builtins only, no new dependency (sibling: scripts/check-diff-coverage.ts,
 * scripts/check-invariants.ts). jscpd would drag in a transitive tree for what
 * a tuned line-shingle detector does in ~120 LOC — so we self-host it. The
 * detection is a classic normalized-line k-window hash: strip whitespace /
 * import lines / comments, slide a window of MIN_LINES over each file, and
 * report windows whose normalized text collides across (or within) files.
 *
 * REPORT-ONLY, DOCUMENTED RATCHET (mirrors the #2353 lint-rule staging): this
 * prints clusters and ALWAYS exits 0 (unless `--strict`). Duplication is noisy
 * on a mature tree; a hard gate now would fail on legacy debt no one is
 * touching. Once the frontend is deduped we flip `--strict` on in CI (or lower
 * MIN_LINES) — the ratchet, not a big-bang gate. Exit 2 on a setup error.
 *
 *   tsx scripts/check-frontend-dup.ts [--strict] [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src');

/** Tuned threshold: a run of >= this many normalized lines that repeats is a
 *  candidate. Low enough to catch a duplicated Card/row, high enough to skip
 *  incidental 2-3 line coincidences. Ratchet DOWN as the tree gets cleaner. */
export const MIN_LINES = 8;

export interface DupBlock {
  /** Normalized text of the repeated window (the fingerprint). */
  readonly normalized: string;
  /** Every place the window occurs: file (repo-relative) + 1-based start line. */
  readonly occurrences: ReadonlyArray<{ readonly file: string; readonly line: number }>;
  readonly lines: number;
}

/** Strip a source line to its structural essence so cosmetic diffs (indent,
 *  trailing commas-only, blank lines) don't hide a real clone, while genuinely
 *  different lines stay distinct. Returns null for lines that shouldn't seed a
 *  window (blank, pure comment, import/export-from). */
export function normalizeLine(raw: string): string | null {
  let s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s === '*/') return null;
  if (/^import\b/.test(s) || /^export\s+\{/.test(s) || /^export\s+\*/.test(s)) return null;
  // Collapse internal whitespace so `a( b )` and `a(b)` match.
  s = s.replace(/\s+/g, ' ');
  return s;
}

interface NormLine {
  readonly text: string;
  readonly line: number; // 1-based line number in the original file
}

function normalizeFile(content: string): NormLine[] {
  const out: NormLine[] = [];
  const raw = content.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const n = normalizeLine(raw[i]);
    if (n !== null) out.push({ text: n, line: i + 1 });
  }
  return out;
}

/** Pure core: given a map of file -> source, find windows of >= MIN_LINES
 *  normalized lines whose text repeats across >= 2 locations. Deterministic
 *  (files/occurrences sorted), so a test can assert exact output. */
export function findDuplicates(
  files: ReadonlyMap<string, string>,
  minLines: number = MIN_LINES,
): DupBlock[] {
  // fingerprint -> occurrences
  const windows = new Map<string, Array<{ file: string; line: number }>>();
  const sortedFiles = [...files.keys()].sort();

  for (const file of sortedFiles) {
    const norm = normalizeFile(files.get(file)!);
    for (let i = 0; i + minLines <= norm.length; i++) {
      const slice = norm.slice(i, i + minLines);
      const fingerprint = slice.map((l) => l.text).join('\n');
      const at = windows.get(fingerprint) ?? [];
      at.push({ file, line: slice[0].line });
      windows.set(fingerprint, at);
    }
  }

  const blocks: DupBlock[] = [];
  for (const [normalized, occ] of windows) {
    if (occ.length < 2) continue;
    const sorted = [...occ].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    blocks.push({ normalized, occurrences: sorted, lines: minLines });
  }
  // Report the biggest offenders first (most occurrences), then by fingerprint
  // for stable ordering.
  blocks.sort((a, b) => b.occurrences.length - a.occurrences.length || (a.normalized < b.normalized ? -1 : 1));
  return blocks;
}

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsxFiles(full, acc);
    } else if (/\.tsx$/.test(entry) && !/\.(test|spec)\.tsx$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const asJson = process.argv.includes('--json');

  let files: Map<string, string>;
  try {
    const paths = collectTsxFiles(SCAN_ROOT);
    files = new Map(paths.map((p) => [path.relative(REPO_ROOT, p), readFileSync(p, 'utf-8')]));
  } catch (err) {
    console.error(`check-frontend-dup: setup error — ${(err as Error).message}`);
    process.exit(2);
  }

  const blocks = findDuplicates(files);

  if (asJson) {
    console.log(JSON.stringify(blocks, null, 2));
  } else {
    console.log(`\nFrontend duplicate-JSX report (report-only) — scanned ${files.size} .tsx files`);
    console.log(`Threshold: ${MIN_LINES}+ identical normalized lines repeated across locations.\n`);
    if (blocks.length === 0) {
      console.log('No duplication clusters above threshold. 🎉\n');
    } else {
      console.log(`${blocks.length} extraction candidate(s) — consider hoisting into a @/components/ui primitive:\n`);
      const shown = blocks.slice(0, 40);
      for (const b of shown) {
        console.log(`• ${b.occurrences.length}× (${b.lines} lines) at:`);
        for (const o of b.occurrences) console.log(`    ${o.file}:${o.line}`);
      }
      if (blocks.length > shown.length) {
        console.log(`\n… and ${blocks.length - shown.length} more (run with --json for the full list).`);
      }
      console.log('');
    }
  }

  // Report-only by default (documented ratchet, mirrors #2353's WARN staging).
  process.exit(strict && blocks.length > 0 ? 1 : 0);
}

// Only run when invoked directly (so the pure core stays importable in tests).
if (process.argv[1] && path.resolve(process.argv[1]).includes('check-frontend-dup')) {
  main();
}
