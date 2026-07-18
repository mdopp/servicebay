/**
 * Learning-proposal store (#2326 slice 1).
 *
 * The Rückkanal (Client → Zentrale): a `propose`-scoped MCP agent submits a
 * proposed assist (frontmatter + body) via the `propose_learning` tool. This
 * module holds the small persistent store of those submissions.
 *
 * Slice-1 scope: PERSIST a submission as a PENDING proposal and enforce the
 * id-governance rules (namespaced `local/<slug>`, additive-only — never shadow a
 * BUILT-IN assist id). It does NOT land anything to `DATA_DIR/local-assists/`
 * (slice 4), does NOT generate an LLM pro/contra (slice 2), and does NOT wire
 * admin approval (slice 3).
 *
 * Persistence: a dedicated JSON file `DATA_DIR/learning-proposals.json` (not the
 * big `config.json`) — the assist domain owns it, and it avoids the config
 * deep-merge/array semantics. Mirrors the local-assists drop-dir precedent of
 * keeping assist state under DATA_DIR.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import {
  ASSIST_KINDS,
  type AssistKind,
  listBuiltinAssistIds,
} from './catalog';

/** Persisted, namespaced id prefix for every proposal-landed assist. */
export const PROPOSAL_ID_NAMESPACE = 'local';

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** The assist frontmatter + body an agent proposes. */
export interface LearningProposalContent {
  title: string;
  whenToUse: string;
  kind: AssistKind;
  tags: string[];
  body: string;
}

export interface LearningProposal extends LearningProposalContent {
  /** Random uuid the store generates. */
  id: string;
  /**
   * The additive, namespaced assist id this proposal would land as, e.g.
   * `local/my-recipe`. Never collides with a BUILT-IN id (enforced on submit).
   */
  assistId: string;
  status: ProposalStatus;
  /** ISO timestamp of submission. */
  submittedAt: string;
  /** Calling agent/token identity, for the admin's audit trail. */
  submittedBy?: string;
}

/** Thrown when a submission fails validation or id-governance. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

const STORE_PATH = () => path.join(DATA_DIR, 'learning-proposals.json');

/** Cap so a runaway/hostile `propose` token can't fill the disk. */
export const MAX_PENDING_PROPOSALS = 100;

/**
 * Slugify a title into a safe, single-segment id stem. Same character class as
 * the assist catalog's filename guard (`[a-z0-9._-]`) so the derived id is a
 * valid `<stem>.md` filename when it lands (slice 4).
 */
export function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '');
}

async function readStore(): Promise<LearningProposal[]> {
  try {
    const raw = await fs.readFile(STORE_PATH(), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LearningProposal[]) : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn('assists', `Failed to read learning-proposals store: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function writeStore(items: LearningProposal[]): Promise<void> {
  const file = STORE_PATH();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(items, null, 2), 'utf-8');
}

/** List all persisted proposals (any status). */
export async function listProposals(): Promise<LearningProposal[]> {
  return readStore();
}

/**
 * Validate a raw submission into a well-formed content record, or throw a
 * `ProposalError` with a caller-friendly message. Rejects missing/blank
 * required fields and an invalid `kind`.
 */
export function validateProposalContent(input: {
  title?: unknown;
  whenToUse?: unknown;
  kind?: unknown;
  tags?: unknown;
  body?: unknown;
}): LearningProposalContent {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ProposalError('`title` is required and must be a non-empty string.');

  const whenToUse = typeof input.whenToUse === 'string' ? input.whenToUse.trim() : '';
  if (!whenToUse) throw new ProposalError('`whenToUse` is required and must be a non-empty string.');

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new ProposalError('`body` is required and must be a non-empty markdown string.');

  if (typeof input.kind !== 'string' || !(ASSIST_KINDS as readonly string[]).includes(input.kind)) {
    throw new ProposalError(`\`kind\` must be one of: ${ASSIST_KINDS.join(', ')}.`);
  }
  const kind = input.kind as AssistKind;

  if (!Array.isArray(input.tags) || !input.tags.every(t => typeof t === 'string')) {
    throw new ProposalError('`tags` must be an array of strings.');
  }
  const tags = (input.tags as string[]).map(t => t.trim()).filter(Boolean);

  return { title, whenToUse, kind, tags, body };
}

/**
 * Derive the additive, namespaced assist id (`local/<slug>`) for a title and
 * enforce id-governance: it MUST NOT shadow a BUILT-IN assist. We check the
 * bare slug against the built-in ids so a proposal can never override a shipped
 * assist by id (`local/servicebay-overview` is fine as a namespaced id, but the
 * base slug `servicebay-overview` colliding with a built-in is rejected — the
 * agent should propose a companion, not shadow the built-in).
 */
export async function deriveProposalAssistId(title: string): Promise<string> {
  const slug = slugifyTitle(title);
  if (!slug) {
    throw new ProposalError('Could not derive a valid slug from the title.');
  }
  const builtinIds = await listBuiltinAssistIds();
  if (builtinIds.includes(slug)) {
    throw new ProposalError(
      `The derived id "${slug}" collides with the built-in assist "${slug}". ` +
        `Propose a companion (a distinct title), don't shadow built-in ${slug}.`,
    );
  }
  return `${PROPOSAL_ID_NAMESPACE}/${slug}`;
}

/**
 * Validate + persist a submission as a PENDING proposal. Returns the created
 * record. Throws `ProposalError` on any validation / id-governance / cap
 * failure. Does NOT land the assist, generate a judgment, or wire approval.
 */
export async function submitProposal(
  input: {
    title?: unknown;
    whenToUse?: unknown;
    kind?: unknown;
    tags?: unknown;
    body?: unknown;
  },
  submittedBy?: string,
): Promise<LearningProposal> {
  const content = validateProposalContent(input);
  const assistId = await deriveProposalAssistId(content.title);

  const existing = await readStore();
  const pending = existing.filter(p => p.status === 'pending');
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    throw new ProposalError(
      `Too many pending proposals (${pending.length}/${MAX_PENDING_PROPOSALS}). ` +
        `The admin needs to resolve existing ones first.`,
    );
  }

  const proposal: LearningProposal = {
    id: randomUUID(),
    assistId,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    ...(submittedBy ? { submittedBy } : {}),
    ...content,
  };
  await writeStore([...existing, proposal]);
  return proposal;
}
