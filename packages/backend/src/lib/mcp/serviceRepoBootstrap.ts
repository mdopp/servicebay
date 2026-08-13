/**
 * The repo-bootstrap step of the standards catalog (#2513).
 *
 * `get_service_standards` is an excellent index that nothing outside an
 * already-connected MCP session referenced: a fresh sibling repo was
 * bootstrapped, chose its stack, its CI and its storage, and only found the
 * catalog at review time. The catalog was never *consulted* because consulting
 * it was not a step anywhere.
 *
 * This module is that step, expressed as data instead of advice: one generated
 * block of markdown that a new service repo's `CLAUDE.md` carries from day one,
 * plus the two pure functions that write and verify it. Three consumers share
 * this single source:
 *   - `serviceStandards.ts` — returns it as the `repoBootstrap` block of
 *     `get_service_standards`, so a connected agent gets the finished text
 *     rather than an instruction to compose one.
 *   - `scripts/bootstrap-service-repo.ts` — `--write` / `--check` / `--print`
 *     for a target repo, so the mechanics are a command, not prose.
 *   - `scripts/check-invariants.ts` + the test suite — assert the step still
 *     exists in the `create-service` recipe and that the pasteable copy has not
 *     drifted from this generator.
 *
 * No imports: consumed by `tsx scripts/*.ts` (no path aliases) as well as by the
 * backend.
 */

export const BOOTSTRAP_MARKER_BEGIN = '<!-- BEGIN SERVICEBAY STANDARDS POINTER (generated — do not edit by hand) -->';
export const BOOTSTRAP_MARKER_END = '<!-- END SERVICEBAY STANDARDS POINTER -->';

/** Substrings the pointer block is worthless without — the check's real assertion. */
export const BOOTSTRAP_REQUIRED_REFERENCES = [
  'get_service_standards',
  'get_assist',
  'standards-gap',
] as const;

/**
 * The `CLAUDE.md` section a new ServiceBay-targeting repo must carry from its
 * first commit. Deliberately verbatim-pasteable: "carry the pointer" is a copy,
 * not an authoring judgment a bootstrapping agent can quietly skip.
 */
export function renderStandardsPointerBlock(): string {
  return [
    BOOTSTRAP_MARKER_BEGIN,
    '',
    '## Standards: fetch them, never re-derive them',
    '',
    'This repo is built for a ServiceBay box, so **ServiceBay\'s standards catalog is',
    'the binding source of its architecture decisions** — this file only points at it.',
    '',
    '1. **Before the first stack, CI, storage, or auth decision**, call the ServiceBay',
    '   MCP tool `get_service_standards` (flavor `servicebay`) and fetch every id it',
    '   lists under `assistsToRead` via `get_assist(id)`. Read first, design second —',
    '   a stack chosen before reading is a stack chosen against the ADRs by accident.',
    '2. **If the ServiceBay MCP is not connected in this session, stop and say so.**',
    '   An unconnected session cannot see the ADRs, so anything it decides about auth,',
    '   health, storage, or CI is a guess. Connecting it is the first task, not an',
    '   optional extra.',
    '3. **The catalog wins.** Where this file and the catalog disagree, this file is',
    '   the stale one — fix it here, not in your head.',
    '4. **Report gaps back.** A missing, ambiguous, or wrong standard is itself a',
    '   finding: file a `standards-gap` issue on `mdopp/servicebay` and propose the',
    '   assist/docs fix. See `get_assist("report-standards-gaps")`.',
    '',
    'This block is generated. Regenerate or verify it from a `mdopp/servicebay`',
    'checkout: `npm run standards:bootstrap -- --write <repo>` / `-- --check <repo>`.',
    '',
    BOOTSTRAP_MARKER_END,
  ].join('\n');
}

/** Why the bootstrap step exists and where it is enforced — surfaced by the tool. */
export const BOOTSTRAP_STEP = {
  step: 'Step 1 of the create-service recipe, before the image and before any stack/CI/storage/auth choice.',
  rule: "A new service repo's CLAUDE.md carries the get_service_standards pointer from its FIRST commit. The loop closes at repo creation, not at first review (#2513).",
  commands: [
    'npm run standards:bootstrap -- --write <repo>   # write/refresh the pointer block in <repo>/CLAUDE.md',
    'npm run standards:bootstrap -- --check <repo>   # exits 1 when the pointer is missing or has drifted',
  ],
  ifMcpNotConnected:
    'A session with no ServiceBay MCP cannot read the ADRs. Say so and connect it before choosing a stack — do not proceed on guesses (this is exactly how a sibling repo shipped past ADR 0001, without /healthz and with an unsafe SQLite setup).',
  recipe: 'create-service',
} as const;

export interface BootstrapCheckResult {
  ok: boolean;
  /** Human-readable reasons the file does not satisfy the bootstrap step. */
  problems: string[];
}

/**
 * Verify a repo's `CLAUDE.md` text carries an up-to-date pointer block.
 * Reports drift (block present but edited) separately from absence, because the
 * fixes differ: regenerate vs. bootstrap.
 */
export function checkStandardsPointer(claudeMd: string): BootstrapCheckResult {
  const problems: string[] = [];
  const start = claudeMd.indexOf(BOOTSTRAP_MARKER_BEGIN);
  const end = claudeMd.indexOf(BOOTSTRAP_MARKER_END);

  if (start < 0 || end < 0) {
    problems.push(
      'CLAUDE.md carries no ServiceBay standards pointer, so nothing in this repo tells an agent that the ADRs live behind get_service_standards (#2513). Run: npm run standards:bootstrap -- --write <repo>',
    );
    return { ok: false, problems };
  }

  const block = claudeMd.slice(start, end + BOOTSTRAP_MARKER_END.length);
  if (block !== renderStandardsPointerBlock()) {
    problems.push(
      'The standards pointer block has drifted from the generator (packages/backend/src/lib/mcp/serviceRepoBootstrap.ts). Regenerate: npm run standards:bootstrap -- --write <repo>',
    );
  }
  for (const ref of BOOTSTRAP_REQUIRED_REFERENCES) {
    if (!block.includes(ref)) problems.push(`The standards pointer block no longer mentions \`${ref}\`.`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Return `claudeMd` with the pointer block inserted or refreshed. Idempotent:
 * an existing block is replaced in place; a file without one gets it appended
 * (or becomes it, when the file is empty/absent).
 */
export function applyStandardsPointer(claudeMd: string): string {
  const block = renderStandardsPointerBlock();
  const start = claudeMd.indexOf(BOOTSTRAP_MARKER_BEGIN);
  const end = claudeMd.indexOf(BOOTSTRAP_MARKER_END);
  if (start >= 0 && end > start) {
    return claudeMd.slice(0, start) + block + claudeMd.slice(end + BOOTSTRAP_MARKER_END.length);
  }
  const body = claudeMd.trimEnd();
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}
