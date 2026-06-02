/**
 * New-code diff-coverage gate (#1548).
 *
 * A repo-wide coverage threshold would fail on years of legacy debt, so we
 * gate the *diff*, not the whole repo: intersect the lines this branch
 * added/modified (`git diff --unified=0 <base>`) with the v8 coverage report
 * (`coverage/coverage-final.json`, produced by `npm run test:coverage`) and
 * fail when the share of *new* lines that are covered falls below the floor in
 * `.diff-coverage.json`. Untouched legacy code is never measured.
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

interface DiffCoverageConfig {
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
// Added/modified lines per file, from the unified=0 diff against the base.
//
// `--unified=0` gives one hunk per contiguous change with zero context, so the
// `+N,M` of each `@@` header is exactly the set of added/modified lines on the
// new side. Deletions (`+N,0`) contribute no new lines and are skipped.
// ---------------------------------------------------------------------------
function changedLinesByFile(baseRef: string): Map<string, Set<number>> {
    let mergeBase = baseRef;
    try {
        // Diff against the merge-base so unrelated commits already on the base
        // branch (that this branch also has) aren't counted as "new".
        mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
        }).trim() || baseRef;
    } catch {
        // No common ancestor resolvable (shallow clone / detached) — fall back
        // to the raw ref; the diff is still meaningful.
    }

    const out = execFileSync(
        'git',
        ['diff', '--unified=0', '--no-color', '--diff-filter=ACMR', mergeBase, '--', '*.ts', '*.tsx'],
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );

    const byFile = new Map<string, Set<number>>();
    let current: Set<number> | null = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('+++ ')) {
            // `+++ b/path` (or `+++ /dev/null` for a deletion).
            const p = line.slice(4).replace(/^b\//, '').trim();
            if (p === '/dev/null') {
                current = null;
                continue;
            }
            current = new Set<number>();
            byFile.set(path.resolve(REPO_ROOT, p), current);
            continue;
        }
        if (line.startsWith('@@') && current) {
            // @@ -a,b +c,d @@  — c is the new-side start, d the count.
            const m = /\+(\d+)(?:,(\d+))?/.exec(line);
            if (!m) continue;
            const start = Number(m[1]);
            const count = m[2] === undefined ? 1 : Number(m[2]);
            for (let i = 0; i < count; i++) current.add(start + i);
        }
    }
    // Drop files with no added lines (pure deletions).
    for (const [file, lines] of byFile) if (lines.size === 0) byFile.delete(file);
    return byFile;
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

function coveredLinesByFile(): Map<string, { executable: Set<number>; covered: Set<number> }> {
    const json = JSON.parse(readFileSync(COVERAGE_JSON, 'utf-8')) as Record<string, FileCoverage>;
    const byFile = new Map<string, { executable: Set<number>; covered: Set<number> }>();
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
// no test exercised them) drop out.
// ---------------------------------------------------------------------------
interface Tally {
    totalNew: number;
    coveredNew: number;
    perFile: { file: string; covered: number; total: number }[];
}

function tallyNewLines(
    changed: Map<string, Set<number>>,
    coverage: Map<string, { executable: Set<number>; covered: Set<number> }>,
): Tally {
    let totalNew = 0;
    let coveredNew = 0;
    const perFile: Tally['perFile'] = [];
    for (const [file, lines] of changed) {
        const cov = coverage.get(file);
        if (!cov) continue;
        let fileTotal = 0;
        let fileCovered = 0;
        for (const ln of lines) {
            if (!cov.executable.has(ln)) continue;
            fileTotal++;
            if (cov.covered.has(ln)) fileCovered++;
        }
        if (fileTotal === 0) continue;
        totalNew += fileTotal;
        coveredNew += fileCovered;
        perFile.push({ file: path.relative(REPO_ROOT, file), covered: fileCovered, total: fileTotal });
    }
    return { totalNew, coveredNew, perFile };
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
    const { totalNew, coveredNew, perFile } = tallyNewLines(changedLinesByFile(baseRef), coveredLinesByFile());

    if (totalNew === 0) {
        console.log(`diff-coverage: no measurable new/modified executable lines vs ${baseRef} — gate passes.`);
        return;
    }

    if (totalNew < config.minChangedLines) {
        console.log(
            `diff-coverage: ${totalNew} new executable line(s) vs ${baseRef} ` +
                `(< ${config.minChangedLines} min) — too small to gate, passes.`,
        );
        return;
    }

    const pct = (coveredNew / totalNew) * 100;
    perFile.sort((a, b) => a.covered / a.total - b.covered / b.total);

    console.log(`diff-coverage: ${coveredNew}/${totalNew} new lines covered = ${pct.toFixed(1)}% (floor ${config.minLineCoverage}%)`);
    for (const f of perFile) {
        const fp = (f.covered / f.total) * 100;
        console.log(`  ${fp.toFixed(0).padStart(3)}%  ${f.covered}/${f.total}  ${f.file}`);
    }

    if (pct + 1e-9 < config.minLineCoverage) {
        console.error(
            `\ndiff-coverage: new-code coverage ${pct.toFixed(1)}% is below the ${config.minLineCoverage}% floor.`,
        );
        console.error('Add tests for the added/modified lines above, or ratchet .diff-coverage.json with a justification.');
        process.exit(1);
    }

    console.log('diff-coverage: floor met.');
}

main();
