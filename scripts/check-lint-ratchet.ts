/**
 * Monotonic lint ratchet for staged design-system rules (#2430).
 *
 * A newly-staged rule ships at `warn` with a documented "burn down, then flip
 * to error" plan instead of a one-shot fix (#2353's `sb/no-raw-color-literal`
 * and `sb/no-raw-ui-primitive`, #2736's `sb/no-raw-api-fetch` — all three have
 * since burned down to 0 and flipped to `error`; `RATCHETED_RULES` below is
 * currently empty until the next one is staged). Warnings alone don't fail
 * anything, so a plan that stays prose flatlines (measured: zero net change
 * over 36 commits on the original two, with violations only *moved* — a
 * component extracted, the same eight primitives reappearing verbatim in the
 * new file).
 *
 * This gate makes the plan structural instead of advisory: the violation count
 * for each rule may only ever go DOWN. CI fails when a commit raises either
 * count above the committed baseline in `.eslint-ratchet-baseline.json`; a
 * local run that measures fewer violations rewrites the baseline, so the
 * ratchet tightens on its own as lint-sweep units land.
 *
 * House pattern, sibling to scripts/check-diff-coverage.ts and
 * scripts/check-invariants.ts — tsx, node: only, no new dep. Counts come from
 * ESLint's own `--format json` output (never a hand-rolled regex over source:
 * the rules' notion of a violation is the rule bodies in eslint.config.mjs, and
 * a second, drifting implementation of "what counts" is how a ratchet starts
 * lying).
 *
 *   tsx scripts/check-lint-ratchet.ts [--check]
 *
 * --check  never writes the baseline (CI mode). A decrease is reported as
 *          stale-baseline slack and passes; only an increase fails.
 *
 * Exits 0 (count held or fell), 1 (a rule's count increased), or 2 on a setup
 * error (ESLint didn't produce parseable JSON, baseline missing under --check).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(REPO_ROOT, '.eslint-ratchet-baseline.json');

/**
 * The rules under ratchet. All are registered at `warn` in eslint.config.mjs;
 * a rule leaves this list when it reaches 0 and is flipped to `error` (at which
 * point ESLint itself is the gate — see docs/ARCHITECTURE_INVARIANTS.md
 * § UI-primitive and design-token reuse, § A single typed API seam).
 *
 * `sb/no-raw-api-fetch` joined in #2736 (with the global `window.fetch`
 * monkey-patch deleted, every raw `fetch('/api/...')` is a call site missing
 * the 401 → /login handler, and the count was growing precisely because the
 * patch hid that — same mechanism, different class) and left again once its
 * baseline hit 0: it is now a hard `error` in eslint.config.mjs, so ESLint
 * itself is the gate from here on.
 *
 * `sb/no-raw-color-literal` left the same way (#2353 colour-token migration
 * complete): its baseline hit 0, so it is now a hard `error` in
 * eslint.config.mjs.
 *
 * `sb/no-raw-ui-primitive` left the same way (#2353 <button>/<table>/<input>
 * migration complete via the lint-sweep units): its baseline hit 0, so it is
 * now a hard `error` in eslint.config.mjs.
 *
 * RATCHETED_RULES is empty for now — the next staged rule joins here the same
 * way (warn + baseline entry) when one is introduced.
 */
const RATCHETED_RULES: readonly string[] = [] as const;

/**
 * Every rule that has staged through this gate so far is scoped to
 * `packages/frontend/src/**` in eslint.config.mjs, so linting that tree
 * measures every violation there is while costing ~20s instead of a
 * full-repo run. Widen this if a future staged rule's `files:` scope widens.
 */
const LINT_TARGETS = ['packages/frontend/src'];

const CHECK_ONLY = process.argv.includes('--check');

interface Baseline {
    $comment?: string;
    updated?: string;
    rules: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Measure: ESLint's own JSON report → per-rule and per-file counts.
// ---------------------------------------------------------------------------
interface EslintResult {
    filePath: string;
    messages: { ruleId: string | null }[];
}

function measure(): { perRule: Map<string, number>; perFile: Map<string, number> } {
    const run = spawnSync('npx', ['eslint', '--format', 'json', ...LINT_TARGETS], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
    });

    // ESLint exits 1 when there are *errors*; the report on stdout is still
    // valid and is what we count. Only an unparseable stdout is a setup error.
    let results: EslintResult[];
    try {
        results = JSON.parse(run.stdout || '');
    } catch {
        console.error('lint-ratchet: eslint did not produce parseable JSON.');
        if (run.error) console.error(String(run.error));
        if (run.stderr) console.error(run.stderr.trim());
        process.exit(2);
    }

    const perRule = new Map<string, number>(RATCHETED_RULES.map((r) => [r, 0]));
    const perFile = new Map<string, number>();
    for (const file of results) {
        let inFile = 0;
        for (const msg of file.messages) {
            if (!msg.ruleId || !perRule.has(msg.ruleId)) continue;
            perRule.set(msg.ruleId, perRule.get(msg.ruleId)! + 1);
            inFile++;
        }
        if (inFile > 0) perFile.set(path.relative(REPO_ROOT, file.filePath), inFile);
    }
    return { perRule, perFile };
}

// ---------------------------------------------------------------------------
function loadBaseline(): Baseline | null {
    if (!existsSync(BASELINE_FILE)) return null;
    const raw = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8')) as Baseline;
    if (!raw || typeof raw.rules !== 'object') {
        throw new Error(`${path.basename(BASELINE_FILE)} has no \`rules\` object.`);
    }
    return raw;
}

function writeBaseline(perRule: Map<string, number>): void {
    const next: Baseline = {
        $comment:
            'Monotonic lint ratchet (#2430) — highest violation count each staged rule is allowed to have. ' +
            'Maintained by scripts/check-lint-ratchet.ts: a local `npm run check:lint-ratchet` rewrites these ' +
            'DOWNWARDS when a sweep lands; CI (`--check`) fails any commit that raises one. Never raise a ' +
            'number by hand — that is the one thing this file exists to prevent. When a count reaches 0, flip ' +
            'that rule to "error" in eslint.config.mjs and drop it from RATCHETED_RULES ' +
            '(docs/ARCHITECTURE_INVARIANTS.md § UI-primitive and design-token reuse).',
        updated: new Date().toISOString().slice(0, 10),
        rules: Object.fromEntries(RATCHETED_RULES.map((r) => [r, perRule.get(r) ?? 0])),
    };
    // A rule that leaves RATCHETED_RULES (flipped to "error") also leaves the
    // file — ESLint itself is the gate for it from then on.
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Compare + report.
// ---------------------------------------------------------------------------
interface Comparison {
    /** Human-readable "rule: now > max" lines — non-empty means FAIL. */
    increased: string[];
    /** Rules measuring below their baseline — the ratchet can tighten. */
    decreased: string[];
    /** Rules at 0 — ready for the flip to "error". */
    cleared: string[];
}

function compare(perRule: Map<string, number>, baseline: Baseline): Comparison {
    const out: Comparison = { increased: [], decreased: [], cleared: [] };
    for (const rule of RATCHETED_RULES) {
        const now = perRule.get(rule) ?? 0;
        const max = Number(baseline.rules[rule] ?? Number.POSITIVE_INFINITY);
        const delta = now - max;
        console.log(`lint-ratchet: ${rule}: ${now} (baseline ${max}, ${delta > 0 ? '+' : ''}${delta})`);
        if (delta > 0) out.increased.push(`${rule}: ${now} > ${max} (+${delta})`);
        if (delta < 0) out.decreased.push(rule);
        if (now === 0) out.cleared.push(rule);
    }
    return out;
}

function failOnIncrease(increased: string[], perFile: Map<string, number>): never {
    const worst = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.error('\nlint-ratchet: violation count went UP — this ratchet only turns one way.');
    for (const line of increased) console.error(`  ${line}`);
    console.error('\nWorst files right now (ratcheted rules only):');
    for (const [file, count] of worst) console.error(`  ${String(count).padStart(4)}  ${file}`);
    console.error(
        '\nFix the new violations (a @/components/ui primitive, a semantic @theme token, ' +
            'or apiFetch from @servicebay/api-client) instead of raising the baseline. ' +
            'See docs/ARCHITECTURE_INVARIANTS.md § UI-primitive and design-token reuse ' +
            'and § A single typed API seam.',
    );
    process.exit(1);
}

function seed(perRule: Map<string, number>): void {
    if (CHECK_ONLY) {
        console.error(`lint-ratchet: no baseline at ${path.basename(BASELINE_FILE)}.`);
        console.error('Run `npm run check:lint-ratchet` locally and commit the generated file.');
        process.exit(2);
    }
    writeBaseline(perRule);
    console.log(`lint-ratchet: seeded ${path.basename(BASELINE_FILE)} — commit it.`);
    for (const rule of RATCHETED_RULES) console.log(`  ${rule}: ${perRule.get(rule)}`);
}

function tighten(decreased: string[], perRule: Map<string, number>): void {
    if (CHECK_ONLY) {
        console.log(
            `lint-ratchet: below baseline for ${decreased.join(', ')} — ` +
                'run `npm run check:lint-ratchet` locally to tighten the committed baseline.',
        );
        return;
    }
    writeBaseline(perRule);
    console.log(`lint-ratchet: tightened baseline for ${decreased.join(', ')} — commit the updated file.`);
}

// ---------------------------------------------------------------------------
function main() {
    const { perRule, perFile } = measure();
    const baseline = loadBaseline();
    if (!baseline) return seed(perRule);

    const { increased, decreased, cleared } = compare(perRule, baseline);
    if (increased.length > 0) failOnIncrease(increased, perFile);
    if (decreased.length > 0) tighten(decreased, perRule);

    for (const rule of cleared) {
        console.log(
            `lint-ratchet: ${rule} is at ZERO — flip it to "error" in eslint.config.mjs, ` +
                'drop it from RATCHETED_RULES, and update docs/ARCHITECTURE_INVARIANTS.md.',
        );
    }
    if (increased.length === 0 && decreased.length === 0) console.log('lint-ratchet: held at baseline.');
}

main();
