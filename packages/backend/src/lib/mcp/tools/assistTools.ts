/**
 * Assist-catalog MCP tools (#2384 extraction): discovery + read of the task-help
 * catalog, the `propose_learning` Rückkanal ingest, its admin review queue, the
 * promotion-drift report, and the new-project standards index.
 */
import { z } from 'zod';
import { listAssists, getAssist, ASSIST_KINDS, listAssistDrift } from '@/lib/assists/catalog';
import {
  submitProposal,
  ProposalError,
  listProposalsForReview,
  getProposalForReview,
  type ProposalStatus,
} from '@/lib/assists/proposals';
import { buildServiceStandards, SERVICE_STANDARDS_FLAVORS } from '../serviceStandards';
import { textResult, errorResult, type ToolRegistration } from './context';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerAssistTools({ server, caller }: ToolRegistration) {
  // --- List Assists (#2146) ---
  // Discover task-help entries (guides, ordered recipes, checklists, footguns,
  // snippets) from the extensible catalog. Pass a free-text `query` describing
  // the task to rank matches; each entry's `whenToUse` lets you self-select the
  // right one, then fetch its full content with `get_assist`.
  server.tool(
    'list_assists',
    'Discover task-help entries from the ServiceBay assist catalog: guides, recipes, checklists, footguns, snippets — AND the platform\'s architecture decision records (kind "adr", ids `adr-NNNN-<slug>`), which live here and nowhere else. Pass a free-text `query` describing your task to rank relevant entries; read the returned `whenToUse` to pick one, then fetch it with get_assist. Use this FIRST when authoring/deploying a new service, when you need an overview of ServiceBay or Solaris, when unsure how to perform a ServiceBay task, or BEFORE deciding anything about auth, networking, backups, installs, tokens, releases or the runtime (there is probably an ADR on it) — so you don\'t re-derive knowledge that already exists.',
    {
      query: z.string().optional().describe('Free-text task description to rank matching entries (e.g. "deploy a new service behind SSO"). Omit to list everything.'),
      kind: z.enum(ASSIST_KINDS).optional().describe('Restrict to one kind: guide | recipe | adr | template | checklist | footgun | snippet.'),
    },
    async ({ query, kind }) => {
      const assists = await listAssists({ query, kind });
      return textResult(assists);
    },
  );

  // --- Get Assist (#2146) ---
  server.tool(
    'get_assist',
    'Fetch the full content (markdown: frontmatter + body) of one assist catalog entry by id. Use list_assists first to find the id.',
    {
      id: z.string().describe('Assist id (the entry id returned by list_assists).'),
    },
    async ({ id }) => {
      const body = await getAssist(id);
      if (!body) return errorResult(`No assist found with id "${id}". Use list_assists to see available entries.`);
      return textResult(body);
    },
  );

  // --- Propose Learning (#2326 slice 1) ---
  // The Rückkanal ingest: a `propose`-scoped agent submits a proposed assist
  // (frontmatter + body). Slice 1 validates + persists it as a PENDING proposal
  // with an additive, namespaced id (`local/<slug>`) that may NOT shadow a
  // built-in assist. It does NOT land the assist, judge it, or wire approval
  // (slices 2–4). Its own `propose` scope means a propose-only token can submit
  // knowledge and nothing else, and a read/mutate token can't submit at all.
  server.tool(
    'propose_learning',
    'Propose a new assist (knowledge entry) to the ServiceBay catalog for admin review. Supply the assist frontmatter — title, whenToUse (one line describing when it applies), kind (guide | recipe | adr | template | checklist | footgun | snippet), tags — plus the markdown body. The submission is validated and queued as a PENDING proposal with a namespaced id `local/<slug>` derived from the title; it does NOT land or take effect until an admin approves it. Proposals are ADDITIVE-ONLY: a title whose slug collides with a built-in assist id is rejected — propose a companion, do not shadow a built-in (updating a built-in is a repo PR). STRONGLY ENCOURAGED: provide an honest `assessment` with genuine pros AND real cons/risks (not just upsides), plus a redundancy check — name any existing assist this duplicates or conflicts with (or "none"). The admin reviews proposals on the basis of your self-assessment; a candid assessment (including honest cons) is more useful than a sales pitch. Requires the `propose` scope.',
    {
      title: z.string().min(1).max(200).describe('Short human-readable title. The namespaced id `local/<slug>` is derived from this.'),
      whenToUse: z.string().min(1).max(500).describe('One line telling an agent when this assist applies — drives self-selection.'),
      kind: z.enum(ASSIST_KINDS).describe('Assist kind: guide | recipe | adr | template | checklist | footgun | snippet.'),
      tags: z.array(z.string()).default([]).describe('Free-form tags for discovery.'),
      body: z.string().min(1).describe('The assist body as markdown.'),
      assessment: z.object({
        pros: z.array(z.string()).describe('Genuine benefits or use-cases this assist addresses.'),
        cons: z.array(z.string()).describe('Real drawbacks, risks, maintenance concerns, or scope limits. Be honest — list real ones, not "none".'),
        redundancyNote: z.string().optional().describe('Does this duplicate or conflict with an existing assist? Name it (e.g. "servicebay-overview"), or write "none".'),
      }).optional().describe('Honest self-assessment of this proposal. Strongly encouraged — the admin needs a fair basis, not a sales pitch.'),
    },
    async ({ title, whenToUse, kind, tags, body, assessment }) => {
      try {
        const proposal = await submitProposal(
          { title, whenToUse, kind, tags, body, assessment },
          caller,
        );
        return textResult({
          ok: true,
          id: proposal.id,
          assistId: proposal.assistId,
          status: proposal.status,
          note: 'Proposal queued as pending. It does not take effect until a ServiceBay admin approves it.',
        });
      } catch (e) {
        if (e instanceof ProposalError) return errorResult(e.message);
        return errorResult(`Error submitting proposal: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // --- Learning-proposal review queue (#2326 s3) ---
  // The admin side of the Rückkanal: surface PENDING proposals so an admin can
  // review the frontmatter + body + submitter self-assessment before acting.
  // These are `read`-scoped and READ-ONLY — the approve/reject DECISION is an
  // admin-only action (frontend route, same auth as approving an access
  // request), NOT an MCP tool. That is what keeps a `propose`-scoped submitter
  // from approving their own proposal: they never get read here (no `read`
  // scope) and there is no MCP approve surface at all.
  server.tool(
    'list_learning_proposals',
    'List learning proposals (submitted via propose_learning) for admin review. Defaults to pending — the admin\'s review queue; pass status="approved", "rejected", or "all". Each entry carries the proposal frontmatter (title, whenToUse, kind, tags), the markdown body, the submitter self-assessment (pros/cons/redundancy, or null), and `siblingProposalIds` — other proposals that would land as the SAME namespaced id `local/<slug>` (proposals are additive-only and never shadow a built-in, so there is no built-in diff, but a same-id local proposal already existing is worth knowing). Reading a proposal does NOT approve it; approving/rejecting is an admin-only action on the dashboard.',
    {
      status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending')
        .describe('Filter by status. Default: pending (the review queue).'),
    },
    async ({ status }) => {
      const proposals = await listProposalsForReview(status as ProposalStatus | 'all');
      return textResult({
        proposals: proposals.map(p => ({
          id: p.id,
          assistId: p.assistId,
          status: p.status,
          title: p.title,
          whenToUse: p.whenToUse,
          kind: p.kind,
          tags: p.tags,
          body: p.body,
          assessment: p.assessment ?? null,
          submittedBy: p.submittedBy,
          submittedAt: p.submittedAt,
          resolvedAt: p.resolvedAt,
          resolvedBy: p.resolvedBy,
          siblingProposalIds: p.siblingProposalIds,
          hasSameIdProposal: p.siblingProposalIds.length > 0,
        })),
      });
    },
  );

  server.tool(
    'get_learning_proposal',
    'Fetch one learning proposal by its id (as returned by propose_learning / list_learning_proposals) for admin review. Returns the full frontmatter, markdown body, submitter self-assessment (or null), status, and `siblingProposalIds` (other proposals sharing the same namespaced id). Read-only — approving/rejecting is an admin-only action on the dashboard, not this tool.',
    {
      id: z.string().min(1).describe('Proposal id.'),
    },
    async ({ id }) => {
      const p = await getProposalForReview(id);
      if (!p) return textResult({ id, status: 'not-found' as const });
      return textResult({
        id: p.id,
        assistId: p.assistId,
        status: p.status,
        title: p.title,
        whenToUse: p.whenToUse,
        kind: p.kind,
        tags: p.tags,
        body: p.body,
        assessment: p.assessment ?? null,
        submittedBy: p.submittedBy,
        submittedAt: p.submittedAt,
        resolvedAt: p.resolvedAt,
        resolvedBy: p.resolvedBy,
        siblingProposalIds: p.siblingProposalIds,
        hasSameIdProposal: p.siblingProposalIds.length > 0,
      });
    },
  );

  // --- List Assist Drift (#2326 s5) ---
  // Read-only promotion-backlog view: landed local-assists (DATA_DIR/local-assists/landed/)
  // that do NOT yet have a corresponding built-in entry in assists/. Mapping:
  //   landed id `local/<slug>` ↔ built-in id `<slug>` (assists/<slug>.md).
  // An entry already present as a built-in is omitted — nothing to promote.
  // Side-effect-free; `read`-scoped so any read token can call it.
  server.tool(
    'list_assist_drift',
    'List landed local-assists (submitted via propose_learning and approved) that do not yet have a corresponding built-in entry in the repo\'s assists/ directory. These are the promotion backlog — each entry is a runtime-only assist that a repo PR adding assists/<slug>.md would make permanent and ship in the image. Returns each entry\'s id (local/<slug>), title, kind, whenToUse, tags, and a promotionHint. Read-only and side-effect-free.',
    {},
    async () => {
      const entries = await listAssistDrift();
      return textResult({ drift: entries, count: entries.length });
    },
  );

  // --- Get Service Standards (#2323) ---
  // A curated *pointer* index (not full text) for building a new project. The
  // `servicebay` flavor lists the platform ADRs a new service must respect
  // (read live from the ADR entries in the assist catalog, so titles can't
  // drift and every pointer is followable with get_assist — #2607), the
  // enforced invariants + gate commands, the assists to read in full, and the
  // template contract. The `generic` flavor returns platform-agnostic dev
  // standards. Backing prose lives in the new-service-standards /
  // generic-project-standards assists (single source of truth).
  server.tool(
    'get_service_standards',
    'Fetch a curated pointer index of the standards for building a new project. flavor="servicebay" (default) returns the platform ADRs a new ServiceBay service must respect, each with the get_assist id that returns its full text, the enforced invariants + gate commands, the assists to read in full via get_assist, and the template contract. flavor="generic" returns platform-agnostic dev standards (commit convention, release discipline, coverage floor, secret hygiene, scripts-over-prose). Use this FIRST when starting a new service/project so you build against the standards instead of re-deriving them.',
    {
      flavor: z.enum(SERVICE_STANDARDS_FLAVORS).optional().default('servicebay')
        .describe('"servicebay" (default) for a new ServiceBay service; "generic" for platform-agnostic dev standards.'),
    },
    async ({ flavor }) => {
      const standards = await buildServiceStandards(flavor);
      return textResult(standards);
    },
  );
}
