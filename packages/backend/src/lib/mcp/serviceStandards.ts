/**
 * Backing logic for the `get_service_standards` MCP tool (#2323).
 *
 * A read-scoped, curated *pointer* index (not full text) that an external
 * client/agent can fetch before building a new project. Two flavors:
 *   - `servicebay` — the platform-specific index for a new ServiceBay service:
 *     the ADRs it must respect, the enforced invariants + gate commands, the
 *     assists to read in full, and the template contract.
 *   - `generic`    — platform-agnostic dev standards (commit / release /
 *     coverage / secret-hygiene / scripts-over-prose) for any new project.
 *
 * Single source of truth: the prose lives in the backing assist files
 * `assists/new-service-standards.md` and `assists/generic-project-standards.md`
 * (kind: checklist), not as hard-coded prose here — this handler only assembles
 * pointers. The ADRs themselves are read from the **assist catalog**
 * (`assists/adr-NNNN-*.md`, `kind: adr`) at runtime, so the titles never drift
 * and — unlike the old `docs/adr/` path, which no MCP tool could open (#2607) —
 * the pointer this tool hands back is one the caller can actually follow with
 * `get_assist(id)`.
 */

import { logger } from '@/lib/logger';
import { listAssists, type AssistSummary } from '@/lib/assists/catalog';
import { BOOTSTRAP_STEP, renderStandardsPointerBlock } from '@/lib/mcp/serviceRepoBootstrap';

export const SERVICE_STANDARDS_FLAVORS = ['servicebay', 'generic'] as const;
export type ServiceStandardsFlavor = (typeof SERVICE_STANDARDS_FLAVORS)[number];

/**
 * The shape of the service being built (#2814). Narrows `assistsToRead` to what
 * actually applies: #2804 measured a 65k-context agent burning 20k tokens on the
 * fixed 15-entry list, six entries of which (data-authority, the uid/journal/
 * forward-auth footguns, image rolling, long-running jobs) do not apply to a
 * static nginx page with no auth, data, jobs or image of its own.
 */
export const SERVICE_SHAPES = [
  'static-site',
  'api',
  'writes-foreign-store',
  'has-ui',
  'has-jobs',
] as const;
export type ServiceShape = (typeof SERVICE_SHAPES)[number];

/** Assist ids of the numbered ADRs: `adr-NNNN-<slug>`. */
const ADR_ASSIST_ID = /^adr-(\d{4})-/;

/**
 * Extra emphasis for the ADRs a *new service* most often walks into. Purely
 * additive: an ADR without an entry here is still returned — the note falls
 * back to the record's own `whenToUse`, which is written for exactly this job.
 * (Before #2607 this list WAS the selection, and the other seven ADRs — 0011
 * among them — appeared in no answer at all.)
 */
const NEW_SERVICE_NOTES: Record<string, string> = {
  '0001': 'Every user-facing service authenticates via Authelia SSO (or at minimum LDAP against LLDAP).',
  '0003': 'Versioning and releases go through release-please only; never hand-bump a version, keep commit subjects parser-clean.',
  '0004': 'Installs/redeploys are non-destructive — they never wipe other services.',
  '0007': 'App containers run in an isolated netns; only named carve-outs stay on host networking.',
  '0009': 'The token & trust model between services: scoped, short-lived grants; no ambient authority.',
  '0010': 'The Node runtime tracks one LTS line, kept consistent across all sources.',
};

interface AdrPointer {
  adr: string;
  title: string;
  note: string;
  /** Catalog id — fetch the FULL text with `get_assist(assist)`. */
  assist: string;
  /** Ready-to-paste call, so the pointer is followable without extra guessing. */
  fetch: string;
}

export interface CuratedAdrScan {
  adrs: AdrPointer[];
  /**
   * Why the scan produced nothing, when it produced nothing for a reason other
   * than "the catalog holds no ADRs". Since the catalog is delivered at runtime
   * (#2701), a failed delivery would otherwise render as an empty
   * `mustRespectAdrs` — an answer that looks clean and is wrong. The reason
   * travels with the result so the caller sees the outage, not a short list.
   */
  error: string | null;
}

/**
 * Return every numbered ADR in the assist catalog, ascending, as a *followable*
 * pointer. Drift-free by construction: nothing about an ADR is restated here —
 * the title and the note come from the record itself.
 *
 * An empty catalog read is logged and returned as an empty list rather than
 * faked: a fabricated pointer is worse than a visibly missing one, because the
 * caller cannot tell it apart from a real answer.
 */
export async function scanCuratedAdrs(): Promise<CuratedAdrScan> {
  let entries: AssistSummary[] = [];
  try {
    entries = await listAssists({ kind: 'adr' });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn('mcp', `get_service_standards: assist catalog unreadable: ${error}`);
    return { adrs: [], error };
  }

  const adrs = entries
    .map(e => ({ e, m: ADR_ASSIST_ID.exec(e.id) }))
    .filter((x): x is { e: AssistSummary; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => a.m[1].localeCompare(b.m[1]));

  if (adrs.length === 0) {
    logger.warn('mcp', 'get_service_standards: no adr-NNNN-* assists found — mustRespectAdrs is empty.');
  }

  return {
    adrs: adrs.map(({ e, m }) => ({
      adr: m[1],
      title: extractAdrTitle(e.title),
      note: NEW_SERVICE_NOTES[m[1]] ?? e.whenToUse,
      assist: e.id,
      fetch: `get_assist("${e.id}")`,
    })),
    error: null,
  };
}

/** Strip the `ADR NNNN — ` prefix from a record's title, keeping the descriptive part. */
function extractAdrTitle(title: string): string {
  return title.replace(/^ADR\s+\d{4}\s*[—-]\s*/, '').trim();
}

interface AssistPointer {
  id: string;
  why: string;
  /**
   * Shapes this assist is MANDATORY reading for. Omitted = core: it applies to
   * every service and is never filtered out.
   */
  shapes?: readonly ServiceShape[];
  /** The symptom that makes it worth fetching for a shape it is not core to. */
  symptom?: string;
}

/**
 * The reading list, with the shape each entry actually serves (#2814). Every
 * entry stays reachable: one a shape doesn't need is demoted from mandatory
 * reading to a one-line `readIfSymptom` pointer, never dropped.
 */
const ASSIST_POINTERS: readonly AssistPointer[] = [
  {
    id: 'new-service-architecture',
    why: 'Recommended defaults (language, structure, libraries, tests, storage, secrets) + the ADRs a new service must respect.',
    // #2804 point 7: this is a question for whoever is DESIGNING a service, and
    // its ADR list duplicates mustRespectAdrs above. A static page has no
    // language, storage or secret decisions left to make.
    shapes: ['api', 'has-ui', 'has-jobs', 'writes-foreign-store'],
    symptom: 'you still have to choose a language, framework, storage engine or secret handling',
  },
  { id: 'create-service', why: 'Concrete recipe to build and deploy a service repo behind SSO.' },
  { id: 'servicebay-overview', why: 'What the platform is and how the pieces fit together.' },
  { id: 'testing-and-ci-gate', why: 'Required standard: a real test suite, thread-aware coverage, and CI that gates image publish on green tests (build-only CI is non-compliant).' },
  {
    id: 'long-running-process',
    why: 'Standard for any operation over ~10s: server-owned durable job, reconnect via the server (not localStorage), survive restart, observable + cancelable.',
    shapes: ['api', 'has-jobs'],
    symptom: 'an operation in your service takes more than ~10s, or a page needs to reconnect to work already running',
  },
  {
    id: 'service-ui-design-standard',
    why: 'UI/design standard for a user-facing service: real ServiceBay design tokens (palette/accent, radii, typography, spacing) + UX baseline (styled large file picker, streaming progress, responsive/mobile, focus states) so the service looks and behaves like ServiceBay.',
    shapes: ['static-site', 'has-ui'],
    symptom: 'you render anything a person looks at',
  },
  {
    id: 'service-ui-user-language',
    why: 'Required for any rendered UI: state texts speak the user\'s language, not the implementation\'s. CLI commands, env-var and header names never reach rendered HTML; every state says what the user can do next; a named action the user cannot trigger is a product gap. Applies docs/UX_PHILOSOPHY.md §5 to a service frontend.',
    shapes: ['static-site', 'has-ui'],
    symptom: 'you write any text a person reads (including an error page)',
  },
  {
    id: 'data-authority',
    why: 'Consume the canonical index (Jellyfin/Immich/Radicale) instead of re-scanning; one writer per store or an explicit coordination model.',
    shapes: ['api', 'writes-foreign-store'],
    symptom: 'you read or write data another service owns',
  },
  {
    id: 'recipe-roll-new-image-to-running-service',
    why: 'How to actually run a freshly-pushed image on an installed service (pull + restart), and the pinned-tag-vs-:latest versioning expectation.',
    shapes: ['api', 'has-ui', 'has-jobs', 'writes-foreign-store'],
    symptom: 'your service ships its own container image that you will rebuild',
  },
  { id: 'report-standards-gaps', why: 'Convention: report missing/ambiguous/wrong standards back so the catalog improves from real friction.' },
  {
    id: 'footgun-journal-is-a-buffer-not-an-archive',
    why: 'Footgun: the systemd journal rotates by size/age with no per-service guarantee — a service whose actions must be reconstructable later writes its own durable log rather than relying on journalctl retention.',
    shapes: ['api', 'has-jobs', 'writes-foreign-store'],
    symptom: 'you need to reconstruct later what your service did',
  },
  {
    id: 'footgun-cross-service-uid-writes',
    why: 'Footgun: container->host uid mapping, foreign ownership, and locks when writing another service’s store.',
    shapes: ['writes-foreign-store'],
    symptom: 'a write into another service’s store fails with EACCES or lands root-owned',
  },
  { id: 'footgun-local-template-write-uid', why: 'Footgun: Local templates must be placed as uid 1000 or write_file EACCES leaves a root-owned stray dir.' },
  {
    id: 'footgun-forward-auth-acme-collision',
    why: 'Footgun: forward-auth vs ACME cert collision.',
    shapes: ['api', 'has-ui'],
    symptom: 'a cert renewal starts failing after you put a route behind forward-auth',
  },
  { id: 'footgun-subdomain-needs-public-domain', why: 'Footgun: a public subdomain needs a public domain.' },
];

const ASSISTS_TO_READ_NOTE =
  'Fetch full text via get_assist(id); use list_assists to read each whenToUse and self-select.';

/**
 * Assemble `assistsToRead`. No `shape` → today's full list, byte-for-byte, so
 * an existing caller sees no change (#2814). With a `shape`, the entries that
 * shape does not need become one-line `readIfSymptom` pointers instead.
 */
function buildAssistsToRead(shape?: ServiceShape) {
  if (!shape) {
    return { note: ASSISTS_TO_READ_NOTE, ids: ASSIST_POINTERS.map(({ id, why }) => ({ id, why })) };
  }
  const applies = (p: AssistPointer) => !p.shapes || p.shapes.includes(shape);
  return {
    note: `${ASSISTS_TO_READ_NOTE} Narrowed to shape "${shape}" — the rest are listed under readIfSymptom, still fetchable by id.`,
    shape,
    ids: ASSIST_POINTERS.filter(applies).map(({ id, why }) => ({ id, why })),
    readIfSymptom: {
      note: 'Not mandatory reading for this shape. Fetch with get_assist(id) only when you hit the symptom.',
      ids: ASSIST_POINTERS.filter(p => !applies(p)).map(p => ({ id: p.id, ifYouHit: p.symptom ?? '' })),
    },
  };
}

interface StandardsBlocks {
  flavor: ServiceStandardsFlavor;
  summary: string;
  fullTextAssist: string;
  [key: string]: unknown;
}

/**
 * Assemble the standards index for a flavor. Read-only; pure assembly of
 * pointers over the curated ADR scan + backing-assist references.
 */
export async function buildServiceStandards(
  flavor: ServiceStandardsFlavor,
  shape?: ServiceShape,
): Promise<StandardsBlocks> {
  if (flavor === 'generic') {
    return {
      flavor,
      summary:
        'Platform-agnostic development standards for any new project. Fetch the full text via get_assist("generic-project-standards").',
      fullTextAssist: 'generic-project-standards',
      // #2513: the sibling repo that shipped past the ADRs was bootstrapped with
      // the GENERIC standards, on a machine with no ServiceBay MCP — so the
      // target-detection step belongs on this flavor too, not only on
      // 'servicebay'. Without it, the generic flavor is a dead end for exactly
      // the case that failed.
      repoBootstrap: {
        step: 'Before the first stack/CI/storage/auth decision: decide where this project will RUN.',
        ifServiceBayTarget:
          'If it will be installed on a ServiceBay box, these generic standards are not enough — fetch get_service_standards(flavor="servicebay") and follow its repoBootstrap block. The platform ADRs (SSO, non-destructive installs, network isolation, service tokens) are binding and are not derivable from generic dev discipline.',
        ifMcpNotConnected: BOOTSTRAP_STEP.ifMcpNotConnected,
        // #2701: this flavor had `step`/`ifServiceBayTarget`/`ifMcpNotConnected`
        // and no pasteable block — exactly what #2513 fixed for the servicebay
        // flavor. A generic project asking for the finished text got advice to
        // compose one, which is the thing #2513 established does not happen.
        claudeMdBlock: renderStandardsPointerBlock('generic'),
        commands: [
          'npm run standards:bootstrap -- --flavor generic --write <repo>   # write/refresh the block in <repo>/CLAUDE.md',
          'npm run standards:bootstrap -- --flavor generic --check <repo>   # exits 1 when the pointer is missing or has drifted',
        ],
      },
      standards: {
        commitConvention:
          'Conventional Commits: `type(scope): description`. Keep subjects parser-clean — no extra parentheses beyond the conventional (scope).',
        releaseDiscipline:
          'Never hand-bump versions/changelogs. Releases are derived from the commit history (release-please principle).',
        testAndCoverage:
          'New/changed code carries tests. Hold a diff-coverage floor of 70% on changed lines; prefer a test per acceptance criterion.',
        secretHygiene:
          'No literal secrets in committed files (keys, tokens, passwords). Inject secrets at deploy/runtime; placeholders only in source.',
        scriptsOverProse:
          'Deterministic, repeatable steps belong in a checked-in script (fixed flags, hard-capped polls, guaranteed cleanup), not prose an agent re-interprets.',
      },
      // #2697: the working agreements four agent sessions arrived at, compared,
      // and had adopted across all of the operator's repos. They are
      // platform-agnostic, so they belong on THIS flavor rather than on
      // 'servicebay' — a project bootstrapped generically is exactly the one
      // that would otherwise re-derive them from its own damage. Almost every
      // rule carries the incident it came from; that is not decoration. A rule
      // without its incident gets misread at the next edge case.
      workingAgreements: {
        note: 'Fetch full text via get_assist(id). Read the first one BEFORE adopting any threshold or autonomy level from the others.',
        ids: [
          { id: 'footgun-importing-a-working-agreement-from-another-repo', why: 'Read first. Portable are the questions and the mechanisms — NOT the thresholds and not the autonomy levels. Release autonomy, how wide repair may go, and how much finding belongs in a ticket are calibrated per project; copying the answer builds the wrong barrier.' },
          { id: 'guide-how-work-enters-and-gets-batched', why: 'Issue before code, cross-repo work becomes a ticket there, batches of up to eight, and the finding-vs-proposal distinction: the acceptance is binding, the route to it is not.' },
          { id: 'checklist-does-this-gate-separate-by-place-or-by-effect', why: 'Ask it of every gate. A gate keyed on a file, directory or repo decides differently for identical work; three projects had the right axis elsewhere in their own rules and had not transferred it. Review gates ask about disclosure, human gates about irreversibility.' },
          { id: 'guide-when-to-ask-and-how-to-put-a-decision-to-the-operator', why: 'Never end a turn with work left over; a report is not a result (done / running / your decision); one question, spelled-out options, costs, recommendation first.' },
          { id: 'recipe-walk-a-human-through-a-manual-acceptance', why: 'Lead the walk-through instead of asking for an assessment. Ask what they SEE, never whether it is right; testability belongs in the planning; one release, one list.' },
          { id: 'checklist-a-measurement-carries-its-own-limits', why: 'Register the binding before measuring; afterwards the limits are FIELDS, not prose. A measurement may reopen a settled decision only when the target state is the named quantity and not in the not-established field.' },
          { id: 'checklist-a-probe-that-cannot-fail-is-not-a-check', why: 'A service asked about itself reliably reports that it is fine. Mutation-proof every check, mind the denominator, and never render a broken read as an empty result.' },
          { id: 'guide-contracts-between-agent-sessions', why: 'The channel carries the message, the ticket carries the content. Whoever changes a promise says so immediately — the costs are asymmetric. Second-hand operator decisions are hearsay.' },
          { id: 'footgun-repair-or-report-infrastructure-you-did-not-build', why: 'The boundary runs along ownership, not the kind of fault. Diagnose before touching — a repair can erase the trail. Self-healing is wrong for configuration faults.' },
        ],
      },
    };
  }

  // flavor === 'servicebay'
  const { adrs: mustRespectAdrs, error: adrScanError } = await scanCuratedAdrs();
  return {
    flavor,
    summary:
      'Curated pointer index for building a new ServiceBay service. Every platform ADR is in the assist catalog — fetch any of them, and each assist below, in full via get_assist(id). Full checklist: get_assist("new-service-standards").',
    fullTextAssist: 'new-service-standards',
    // #2513: step 1 of building a service repo, served as finished text rather
    // than as an instruction to compose one. A repo created without this block
    // has no link back into the catalog, and the next agent in it re-derives
    // everything the ADRs already decided.
    repoBootstrap: {
      ...BOOTSTRAP_STEP,
      claudeMdBlock: renderStandardsPointerBlock(),
    },
    mustRespectAdrs,
    // #2607: the ADRs are catalog entries now, so they are ALSO reachable
    // without this tool — which mattered, because this tool's own entry
    // condition is "building a new service", and whoever is fixing a probe or
    // touching a template never had a reason to call it.
    adrCatalog: {
      note: 'Every ADR is an assist (kind "adr", id "adr-NNNN-<slug>"). Fetch full text with get_assist(id), or find one by situation with list_assists(kind="adr") — each whenToUse line names when that decision applies.',
      listCall: 'list_assists(kind="adr")',
      count: mustRespectAdrs.length,
      // #2701: the catalog is delivered at runtime. When delivery is broken this
      // says so; without it an outage would show up as `count: 0`, which reads
      // like a finished answer.
      ...(adrScanError ? { unavailable: adrScanError } : {}),
    },
    enforcedInvariants: {
      pointer: 'docs/ARCHITECTURE_INVARIANTS.md',
      note: 'Enforced by scripts, not prose. Run the gates before an architecture change and before opening a PR.',
      gateCommands: [
        'npm run check:arch  # architecture invariants + dependency-cruiser',
        'npm run lint        # zero errors; do not raise the warning count',
      ],
      diffCoverageFloor: '70% on changed lines',
      testGate:
        'CI must gate image publish on a green test job (build/publish needs: test); a build-only CI is non-compliant. New service targets >= 85% total coverage with thread/async coverage on. See get_assist("testing-and-ci-gate").',
    },
    reportGapsBack: {
      note: 'Reporting a standards gap is itself a standard. If you had to guess, were corrected, or found a missing/ambiguous/wrong standard while building, close the loop: file a mdopp/servicebay issue with the `standards-gap` label and, if you worked out the answer, propose an assist/docs update (a Local assist drop is a fine first home, then it gets promoted to a built-in). See get_assist("report-standards-gaps").',
      assist: 'report-standards-gaps',
    },
    assistsToRead: buildAssistsToRead(shape),
    templateContract: {
      note: 'Services ship as templates, not code.',
      pointers: ['docs/TEMPLATE_AUTHORING.md', 'templates/CLAUDE.md'],
    },
  };
}
