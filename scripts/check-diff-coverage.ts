/**
 * New-code diff-coverage gate (#1548), move-aware since #2762.
 *
 * A repo-wide coverage threshold would fail on years of legacy debt, so we
 * gate the *diff*, not the whole repo: intersect the lines this branch
 * added/modified (`git diff --unified=0 <base>`) with the v8 coverage report
 * (`coverage/coverage-final.json`, produced by `npm run test:coverage`) and
 * fail when the share of *new* lines that are covered falls below the floor in
 * `.diff-coverage.json`. Untouched legacy code is never measured.
 *
 * ## Move-awareness (#2762) — why a relocated line is not new code
 *
 * A god-module cut (`install/runner.ts` → `install/phases/*.ts`, #2742) is a
 * pure code *move*: every `+` line already existed, verbatim, in the base tree.
 * The plain diff cannot tell that apart from freshly written logic, so the cut
 * paid a 12-test-file tax to re-cover code whose risk had not changed — and
 * every future split (#2743 and on) would pay it again.
 *
 * So the gate now builds a **base pool**: the trimmed content of every line
 * that *left* the base tree in this diff — the `-` side of each hunk, plus the
 * full base text of files the diff deleted or renamed away (those never appear
 * as `-` lines, because the diff is `--diff-filter=ACMR`). An added line is
 * treated as **moved** when its trimmed text is in that pool and is not a
 * trivial token (punctuation, a bare `import`, a comment, anything under 8
 * chars) — matching on those would exempt half of every diff.
 *
 * The exemption is deliberately narrow, on two axes:
 *  - it only ever *removes uncovered moved lines from the denominator*. A moved
 *    line that IS covered still counts as covered, so a move can never inflate
 *    the percentage — the gate stays a floor on genuinely new logic.
 *  - it needs a byte-identical (post-trim) match against something that left
 *    the tree. A re-typed or re-indented line is new code again, and a copy out
 *    of a file that did not shrink is not exempt at all.
 *
 * Exempt lines are reported (`… (N moved lines exempt)`, per file too) so a
 * suspiciously large exemption is visible in the CI log rather than silent.
 *
 * House pattern, sibling to scripts/check-invariants.ts — tsx, node:fs only,
 * no new runtime dep. Runs in the full/seal gate (CI `test` job), NOT the
 * per-issue fast gate (which stays `vitest --changed`).
 *
 * Exits 0 (floor met / nothing measurable) or 1 (below floor). Exit 2 on a
 * setup error (missing report, bad git base) — that's a misconfiguration, not
 * a coverage failure, and should be loud.
 *
 *   tsx scripts/check-diff-coverage.ts [baseRef]
 *
 * baseRef defaults to $DIFF_COVERAGE_BASE or origin/main.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const COVERAGE_JSON = path.join(REPO_ROOT, 'coverage', 'coverage-final.json');
const CONFIG_FILE = path.join(REPO_ROOT, '.diff-coverage.json');

export interface DiffCoverageConfig {
    minLineCoverage: number;
    minChangedLines: number;
}

// ---------------------------------------------------------------------------
// Config (the ratchetable floor).
// ---------------------------------------------------------------------------
function loadConfig(): DiffCoverageConfig {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    const minLineCoverage = Number(raw.minLineCoverage);
    const minChangedLines = Number(raw.minChangedLines ?? 0);
    if (!Number.isFinite(minLineCoverage) || minLineCoverage < 0 || minLineCoverage > 100) {
        throw new Error(`.diff-coverage.json minLineCoverage must be 0-100, got ${raw.minLineCoverage}`);
    }
    return { minLineCoverage, minChangedLines };
}

// ---------------------------------------------------------------------------
// Diff facts: the added lines (number → text) per file, and the pool of lines
// that left the base tree (candidate move sources).
//
// `--unified=0` gives one hunk per contiguous change with zero context, so the
// `+N,M` of each `@@` header is exactly the set of added/modified lines on the
// new side, and the `+`/`-` bodies that follow it are those lines' text.
// ---------------------------------------------------------------------------
export interface DiffFacts {
    /** absolute file path → (new-side line number → added line text) */
    addedByFile: Map<string, Map<number, string>>;
    /** trimmed, non-trivial text of every line that left the base tree */
    basePool: Set<string>;
}

/**
 * Is this line too generic to prove a move? Punctuation, bare imports,
 * comments and very short statements recur everywhere, so matching on them
 * would exempt unrelated new code. Exported for tests.
 */
export function isTrivialLine(trimmed: string): boolean {
    if (trimmed.length < 8) return true;
    if (/^[()[\]{}<>;,.:?\s|&]+$/.test(trimmed)) return true;
    if (/^[)\]}]*\s*(?:else|try|do|finally)\s*\{?$/.test(trimmed)) return true;
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
    if (/^(?:import\b|export\s*[{*]|from\s)/.test(trimmed)) return true;
    return false;
}

/** Fold a base-tree file's full text into the move pool. Exported for tests. */
export function addToBasePool(pool: Set<string>, text: string): void {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!isTrivialLine(trimmed)) pool.add(trimmed);
    }
}

/** Parse `git diff --unified=0` output into added lines + the move pool. */
export function parseDiff(diffText: string, repoRoot: string): DiffFacts {
    const addedByFile = new Map<string, Map<number, string>>();
    const basePool = new Set<string>();
    let current: Map<number, string> | null = null;
    let nextLine = 0;
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ ')) {
            // `+++ b/path` (or `+++ /dev/null` for a deletion).
            const p = line.slice(4).replace(/^b\//, '').trim();
            if (p === '/dev/null') {
                current = null;
                continue;
            }
            current = new Map<number, string>();
            addedByFile.set(path.resolve(repoRoot, p), current);
            continue;
        }
        if (line.startsWith('--- ') || line.startsWith('diff --git ')) continue;
        if (line.startsWith('@@')) {
            // @@ -a,b +c,d @@  — c is the new-side start of this hunk.
            const m = /\+(\d+)(?:,(\d+))?/.exec(line);
            nextLine = m ? Number(m[1]) : 0;
            continue;
        }
        if (line.startsWith('-')) {
            const trimmed = line.slice(1).trim();
            if (!isTrivialLine(trimmed)) basePool.add(trimmed);
            continue;
        }
        if (line.startsWith('+') && current && nextLine > 0) {
            current.set(nextLine, line.slice(1));
            nextLine++;
        }
    }
    // Drop files with no added lines (pure deletions).
    for (const [file, lines] of addedByFile) if (lines.size === 0) addedByFile.delete(file);
    return { addedByFile, basePool };
}

/**
 * Run the two git reads and assemble the facts: the ACMR diff (added lines +
 * the `-` side of every file that shrank) and the base text of files the diff
 * deleted or renamed away, which the ACMR filter hides entirely.
 */
export function readDiffFacts(baseRef: string, repoRoot: string = REPO_ROOT): DiffFacts {
    const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

    let mergeBase = baseRef;
    try {
        // Diff against the merge-base so unrelated commits already on the base
        // branch (that this branch also has) aren't counted as "new".
        mergeBase = git(['merge-base', 'HEAD', baseRef]).trim() || baseRef;
    } catch {
        // No common ancestor resolvable (shallow clone / detached) — fall back
        // to the raw ref; the diff is still meaningful.
    }

    const facts = parseDiff(
        git(['diff', '--unified=0', '--no-color', '--diff-filter=ACMR', mergeBase, '--', '*.ts', '*.tsx']),
        repoRoot,
    );

    // Files that vanished: their lines are the classic move source, and they
    // appear in neither the ACMR diff's `+` nor its `-` side.
    const status = git(['diff', '--name-status', '-M', '--no-color', mergeBase, '--', '*.ts', '*.tsx']);
    for (const row of status.split('\n')) {
        const cols = row.split('\t');
        if (!cols[0] || !cols[1]) continue;
        if (cols[0][0] !== 'D' && cols[0][0] !== 'R') continue;
        try {
            addToBasePool(facts.basePool, git(['show', `${mergeBase}:${cols[1]}`]));
        } catch {
            // Unreadable base blob (submodule, odd mode) — skip it; the pool is
            // an optimisation, never a correctness requirement.
        }
    }
    return facts;
}

// ---------------------------------------------------------------------------
// Covered/total executable lines per file, from the v8 (istanbul-shaped) JSON.
//
// Each file entry has statementMap[id] = {start:{line}, end:{line}} and
// s[id] = hit count. A source line is "covered" if any statement spanning it
// ran at least once; "executable" if any statement spans it at all. Lines with
// no statement (blanks, comments, braces) are not counted either way.
// ---------------------------------------------------------------------------
interface FileCoverage {
    statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
    s: Record<string, number>;
}

export interface LineCoverage {
    executable: Set<number>;
    covered: Set<number>;
}

function coveredLinesByFile(): Map<string, LineCoverage> {
    const json = JSON.parse(readFileSync(COVERAGE_JSON, 'utf-8')) as Record<string, FileCoverage>;
    const byFile = new Map<string, LineCoverage>();
    for (const [file, cov] of Object.entries(json)) {
        const executable = new Set<number>();
        const covered = new Set<number>();
        for (const [id, stmt] of Object.entries(cov.statementMap)) {
            const hits = cov.s[id] ?? 0;
            for (let ln = stmt.start.line; ln <= stmt.end.line; ln++) {
                executable.add(ln);
                if (hits > 0) covered.add(ln);
            }
        }
        byFile.set(path.resolve(file), { executable, covered });
    }
    return byFile;
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
// Intersect the changed lines with the coverage report → per-file + total
// counts of *executable* new lines and how many of them ran. Non-executable
// new lines (comments/blanks/types) and uninstrumented files (excluded paths /
// no test exercised them) drop out, and so do uncovered lines that merely
// moved (see the move-awareness note at the top).
// ---------------------------------------------------------------------------
export interface Tally {
    totalNew: number;
    coveredNew: number;
    exemptMoved: number;
    perFile: { file: string; covered: number; total: number; exempt: number }[];
}

export function tallyNewLines(facts: DiffFacts, coverage: Map<string, LineCoverage>, repoRoot: string = REPO_ROOT): Tally {
    let totalNew = 0;
    let coveredNew = 0;
    let exemptMoved = 0;
    const perFile: Tally['perFile'] = [];
    for (const [file, added] of facts.addedByFile) {
        const cov = coverage.get(file);
        if (!cov) continue;
        let fileTotal = 0;
        let fileCovered = 0;
        let fileExempt = 0;
        for (const [ln, text] of added) {
            if (!cov.executable.has(ln)) continue;
            if (cov.covered.has(ln)) {
                // A covered moved line still counts as covered — the exemption
                // only ever shrinks the denominator, never pads the numerator.
                fileTotal++;
                fileCovered++;
                continue;
            }
            const trimmed = text.trim();
            if (!isTrivialLine(trimmed) && facts.basePool.has(trimmed)) {
                fileExempt++;
                continue;
            }
            fileTotal++;
        }
        exemptMoved += fileExempt;
        if (fileTotal === 0) continue;
        totalNew += fileTotal;
        coveredNew += fileCovered;
        perFile.push({ file: path.relative(repoRoot, file), covered: fileCovered, total: fileTotal, exempt: fileExempt });
    }
    return { totalNew, coveredNew, exemptMoved, perFile };
}

/** How the gate reads a tally. Pure, so the fixtures can assert on it. */
export interface Verdict {
    pass: boolean;
    pct: number | null;
    reason: 'no-new-lines' | 'too-small' | 'floor-met' | 'below-floor';
}

export function verdict(tally: Tally, config: DiffCoverageConfig): Verdict {
    if (tally.totalNew === 0) return { pass: true, pct: null, reason: 'no-new-lines' };
    if (tally.totalNew < config.minChangedLines) return { pass: true, pct: null, reason: 'too-small' };
    const pct = (tally.coveredNew / tally.totalNew) * 100;
    return pct + 1e-9 < config.minLineCoverage
        ? { pass: false, pct, reason: 'below-floor' }
        : { pass: true, pct, reason: 'floor-met' };
}

// ---------------------------------------------------------------------------
function main() {
    const baseRef = process.argv[2] || process.env.DIFF_COVERAGE_BASE || 'origin/main';

    if (!existsSync(COVERAGE_JSON)) {
        console.error(`diff-coverage: no coverage report at ${path.relative(REPO_ROOT, COVERAGE_JSON)}.`);
        console.error('Run `npm run test:coverage` first (CI does this in the test job).');
        process.exit(2);
    }

    const config = loadConfig();
    const tally = tallyNewLines(readDiffFacts(baseRef), coveredLinesByFile());
    const { totalNew, coveredNew, exemptMoved, perFile } = tally;
    const moved = exemptMoved > 0 ? ` (${exemptMoved} moved line(s) exempt)` : '';
    const decision = verdict(tally, config);

    if (decision.reason === 'no-new-lines') {
        console.log(`diff-coverage: no measurable new/modified executable lines vs ${baseRef} — gate passes.${moved}`);
        return;
    }

    if (decision.reason === 'too-small') {
        console.log(
            `diff-coverage: ${totalNew} new executable line(s) vs ${baseRef} ` +
                `(< ${config.minChangedLines} min) — too small to gate, passes.${moved}`,
        );
        return;
    }

    const pct = decision.pct as number;
    perFile.sort((a, b) => a.covered / a.total - b.covered / b.total);

    console.log(
        `diff-coverage: ${coveredNew}/${totalNew} new lines covered = ${pct.toFixed(1)}% (floor ${config.minLineCoverage}%)${moved}`,
    );
    for (const f of perFile) {
        const fp = (f.covered / f.total) * 100;
        const fe = f.exempt > 0 ? `  (+${f.exempt} moved)` : '';
        console.log(`  ${fp.toFixed(0).padStart(3)}%  ${f.covered}/${f.total}  ${f.file}${fe}`);
    }

    if (!decision.pass) {
        console.error(
            `\ndiff-coverage: new-code coverage ${pct.toFixed(1)}% is below the ${config.minLineCoverage}% floor.`,
        );
        console.error('Add tests for the added/modified lines above, or ratchet .diff-coverage.json with a justification.');
        process.exit(1);
    }

    console.log('diff-coverage: floor met.');
}

// Only run when invoked directly, so the tests can import the pure pieces.
const invoked = process.argv[1] ?? '';
if (invoked.endsWith('check-diff-coverage.ts') || invoked.endsWith('check-diff-coverage.js')) {
    main();
}
