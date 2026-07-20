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
 * pointers. The ADR one-liners are scanned from `docs/adr/*.md` titles at
 * runtime (below) so the *selection* is hand-curated but the *titles* never
 * drift from the source.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '@/lib/logger';

export const SERVICE_STANDARDS_FLAVORS = ['servicebay', 'generic'] as const;
export type ServiceStandardsFlavor = (typeof SERVICE_STANDARDS_FLAVORS)[number];

/** Repo-root `docs/adr/` (shipped to /app/docs/adr in the container image). */
const ADR_DIR = () => path.join(process.cwd(), 'docs', 'adr');

/** The curated ADR selection a new ServiceBay service is bound by (#2323). */
const CURATED_ADRS: { num: string; note: string }[] = [
  { num: '0001', note: 'Every user-facing service authenticates via Authelia SSO (or at minimum LDAP against LLDAP).' },
  { num: '0003', note: 'Versioning and releases go through release-please only; never hand-bump a version, keep commit subjects parser-clean.' },
  { num: '0004', note: 'Installs/redeploys are non-destructive — they never wipe other services.' },
  { num: '0007', note: 'App containers run in an isolated netns; only named carve-outs stay on host networking.' },
  { num: '0009', note: 'The token & trust model between services: scoped, short-lived grants; no ambient authority.' },
  { num: '0010', note: 'The Node runtime tracks the Node 20 line, kept consistent across all sources.' },
];

// The 0009 slot has two files (repair-is-reconciliation and service-tokens);
// this tool means the tokens-and-trust one for its trust-model pointer.
const ADR_FILE_HINTS: Record<string, string> = {
  '0009': 'service-tokens',
};

export interface AdrPointer {
  adr: string;
  title: string;
  note: string;
  path: string;
}

/**
 * Scan `docs/adr/*.md` and return the title + relative path for each curated
 * ADR number, keyed by its `# ADR NNNN — <title>` heading. Drift-free: only the
 * *selection* (`CURATED_ADRS`) is hand-maintained; titles come from the source.
 * If the dir is unavailable at runtime, falls back to the curated note as title
 * so the tool still returns a usable pointer.
 */
export async function scanCuratedAdrs(): Promise<AdrPointer[]> {
  const dir = ADR_DIR();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.md') && /^\d{4}-/.test(f));
  } catch (e) {
    logger.warn('mcp', `get_service_standards: docs/adr unavailable, using curated fallbacks: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result: AdrPointer[] = [];
  for (const { num, note } of CURATED_ADRS) {
    // Prefer a hinted file when the number has more than one ADR (0009).
    const candidates = files.filter(f => f.startsWith(`${num}-`));
    const hint = ADR_FILE_HINTS[num];
    const file = (hint && candidates.find(f => f.includes(hint))) ?? candidates[0];

    let title = '';
    if (file) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        title = extractAdrTitle(raw);
      } catch {
        /* fall through to fallback title */
      }
    }
    result.push({
      adr: num,
      title: title || note,
      note,
      path: file ? `docs/adr/${file}` : `docs/adr/${num}-*.md`,
    });
  }
  return result;
}

/** Pull the human title out of an ADR's `# ADR NNNN — <title>` heading. */
function extractAdrTitle(raw: string): string {
  const line = raw.split('\n').find(l => /^#\s+/.test(l));
  if (!line) return '';
  // Strip the leading `# ADR NNNN — ` prefix, keep the descriptive title.
  return line
    .replace(/^#\s+/, '')
    .replace(/^ADR\s+\d{4}\s*[—-]\s*/, '')
    .trim();
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
export async function buildServiceStandards(flavor: ServiceStandardsFlavor): Promise<StandardsBlocks> {
  if (flavor === 'generic') {
    return {
      flavor,
      summary:
        'Platform-agnostic development standards for any new project. Fetch the full text via get_assist("generic-project-standards").',
      fullTextAssist: 'generic-project-standards',
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
    };
  }

  // flavor === 'servicebay'
  const mustRespectAdrs = await scanCuratedAdrs();
  return {
    flavor,
    summary:
      'Curated pointer index for building a new ServiceBay service. Read the referenced docs/ files directly and fetch each assist in full via get_assist(id). Full checklist: get_assist("new-service-standards").',
    fullTextAssist: 'new-service-standards',
    mustRespectAdrs,
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
    assistsToRead: {
      note: 'Fetch full text via get_assist(id); use list_assists to read each whenToUse and self-select.',
      ids: [
        { id: 'new-service-architecture', why: 'Recommended defaults (language, structure, libraries, tests, storage, secrets) + the ADRs a new service must respect.' },
        { id: 'create-service', why: 'Concrete recipe to build and deploy a service repo behind SSO.' },
        { id: 'servicebay-overview', why: 'What the platform is and how the pieces fit together.' },
        { id: 'testing-and-ci-gate', why: 'Required standard: a real test suite, thread-aware coverage, and CI that gates image publish on green tests (build-only CI is non-compliant).' },
        { id: 'long-running-process', why: 'Standard for any operation over ~10s: server-owned durable job, reconnect via the server (not localStorage), survive restart, observable + cancelable.' },
        { id: 'service-ui-design-standard', why: 'UI/design standard for a user-facing service: real ServiceBay design tokens (palette/accent, radii, typography, spacing) + UX baseline (styled large file picker, streaming progress, responsive/mobile, focus states) so the service looks and behaves like ServiceBay.' },
        { id: 'data-authority', why: 'Consume the canonical index (Jellyfin/Immich/Radicale) instead of re-scanning; one writer per store or an explicit coordination model.' },
        { id: 'recipe-roll-new-image-to-running-service', why: 'How to actually run a freshly-pushed image on an installed service (pull + restart), and the pinned-tag-vs-:latest versioning expectation.' },
        { id: 'report-standards-gaps', why: 'Convention: report missing/ambiguous/wrong standards back so the catalog improves from real friction.' },
        { id: 'footgun-cross-service-uid-writes', why: 'Footgun: container->host uid mapping, foreign ownership, and locks when writing another service’s store.' },
        { id: 'footgun-local-template-write-uid', why: 'Footgun: Local templates must be placed as uid 1000 or write_file EACCES leaves a root-owned stray dir.' },
        { id: 'footgun-forward-auth-acme-collision', why: 'Footgun: forward-auth vs ACME cert collision.' },
        { id: 'footgun-subdomain-needs-public-domain', why: 'Footgun: a public subdomain needs a public domain.' },
      ],
    },
    templateContract: {
      note: 'Services ship as templates, not code.',
      pointers: ['docs/TEMPLATE_AUTHORING.md', 'templates/CLAUDE.md'],
    },
  };
}
