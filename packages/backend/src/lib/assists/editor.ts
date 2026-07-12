/**
 * Assists catalog editor (#2221, child A of #2147).
 *
 * The write side of the assist catalog (`catalog.ts` is the read side): an
 * agent or operator proposes an edit, a ServiceBay admin approves or rejects,
 * and every applied edit is versioned in an append-only history so a revert is
 * always possible. Nothing is written to the Local drop dir until an admin
 * approves — a revert, too, is an approval REQUEST, never a silent rewrite.
 *
 * Layout under DATA_DIR:
 *   local-assists/<id>.md                 the applied Local override (catalog reads this)
 *   local-assists/.proposals/<id>.md      a pending proposal body, keyed by approval request id
 *   local-assists/.history/<id>/index.jsonl   append-only history index (one JSON obj per line)
 *   local-assists/.history/<id>/<version>.md  the frozen content of each applied version
 *
 * The approval side reuses the generic approvals queue (`approvals/index.ts`):
 * a proposal creates a pending request whose `payload` carries the assist id,
 * the proposal body path, the commit message, and (for a revert) the source
 * version. Approve/reject route through this module's `applyApproved` /
 * `discardRejected` so the actual local-assists write + history append is one
 * transactional step tied to the request lifecycle.
 */

import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import { ASSIST_KINDS } from '@/lib/assists/catalog';

const TAG = 'assists:editor';

const LOCAL_ASSISTS_DIR = () => path.join(DATA_DIR, 'local-assists');
const PROPOSALS_DIR = () => path.join(LOCAL_ASSISTS_DIR(), '.proposals');
const HISTORY_DIR = () => path.join(LOCAL_ASSISTS_DIR(), '.history');

/**
 * High-signal committed-secret formats — the SAME rules as
 * `tests/backend/assist_consistency.test.ts` (kept in sync deliberately; that
 * test is the repo-scan backstop, this is the runtime propose-time gate). A
 * proposal whose body matches any of these is rejected before it can ever be
 * approved into the Local drop dir.
 */
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'ServiceBay token (sb_)', re: /\bsb_[a-z0-9]{6,}_[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

/** Name of the first secret pattern the text matches, or null if clean. */
export function scanForSecret(text: string): string | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

/**
 * Collapse a request-supplied id to a single, safe filename segment and reject
 * traversal — only a plain `<id>` is ever joined onto a data-dir root, so a
 * write can never escape it (path-injection guard; CodeQL js/path-injection).
 * Mirrors `catalog.ts:assistFileName`. Returns null for an unsafe id.
 */
export function safeAssistId(id: string): string | null {
  if (typeof id !== 'string') return null;
  const segment = path.basename(id);
  if (
    !segment ||
    segment !== id ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0')
  ) {
    return null;
  }
  return segment;
}

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalValidationError';
  }
}

/**
 * Validate a proposal body: it must parse as frontmatter+markdown and carry the
 * required fields (`title`, `whenToUse`, a valid `kind`), and must not contain a
 * committed secret. Throws {@link ProposalValidationError} on any failure — the
 * message is caller-safe (no secret value echoed).
 */
export function validateProposal(content: string): void {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ProposalValidationError('proposal content is empty');
  }

  const secret = scanForSecret(content);
  if (secret) {
    throw new ProposalValidationError(`proposal contains a possible secret (${secret}); remove it before proposing`);
  }

  let data: Record<string, unknown>;
  try {
    data = matter(content).data as Record<string, unknown>;
  } catch (e) {
    throw new ProposalValidationError(`unparseable frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }

  const title = data.title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new ProposalValidationError('frontmatter is missing a non-empty "title"');
  }

  // Accept camelCase or snake_case for the human-facing hint, mirroring catalog.
  const whenRaw = data.whenToUse ?? data.when_to_use;
  if (typeof whenRaw !== 'string' || !whenRaw.trim()) {
    throw new ProposalValidationError('frontmatter is missing a non-empty "whenToUse"');
  }

  const kind = data.kind;
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new ProposalValidationError('frontmatter is missing "kind"');
  }
  if (!(ASSIST_KINDS as readonly string[]).includes(kind)) {
    throw new ProposalValidationError(`invalid kind "${kind}"; must be one of ${ASSIST_KINDS.join('|')}`);
  }
}

/** Metadata carried on the approval request's `payload` for the assist editor. */
export interface AssistProposalPayload {
  kind: 'assist-edit';
  assistId: string;
  message: string;
  /** For a revert proposal: the source version being reverted to. */
  revertOf?: number;
  [key: string]: unknown;
}

export interface HistoryEntry {
  version: number;
  author: string;
  timestamp: string;
  message: string;
}

async function readProposalContent(assistId: string, requestId: string): Promise<string> {
  const file = path.join(PROPOSALS_DIR(), `${assistId}.${requestId}.md`);
  return fs.readFile(file, 'utf-8');
}

/** Persist a proposal body to the pending-proposals dir. */
export async function writeProposal(assistId: string, requestId: string, content: string): Promise<void> {
  const id = safeAssistId(assistId);
  if (!id) throw new Error(`invalid assist id: "${assistId}"`);
  await fs.mkdir(PROPOSALS_DIR(), { recursive: true });
  const file = path.join(PROPOSALS_DIR(), `${id}.${requestId}.md`);
  await fs.writeFile(file, content, 'utf-8');
}

async function removeProposal(assistId: string, requestId: string): Promise<void> {
  const file = path.join(PROPOSALS_DIR(), `${assistId}.${requestId}.md`);
  await fs.rm(file, { force: true });
}

/**
 * Read the ordered history for an assist (oldest first). `[]` when the entry
 * has never been edited.
 */
export async function readHistory(assistId: string): Promise<HistoryEntry[]> {
  const id = safeAssistId(assistId);
  if (!id) return [];
  const indexFile = path.join(HISTORY_DIR(), id, 'index.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(indexFile, 'utf-8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as HistoryEntry);
    } catch {
      logger.warn(TAG, `skipping corrupt history line for "${id}"`);
    }
  }
  return entries.sort((a, b) => a.version - b.version);
}

/** Read the frozen content of a specific history version, or null if unknown. */
export async function readHistoryVersion(assistId: string, version: number): Promise<string | null> {
  const id = safeAssistId(assistId);
  if (!id || !Number.isInteger(version) || version < 1) return null;
  const file = path.join(HISTORY_DIR(), id, `${version}.md`);
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Apply an approved proposal: write the body to the Local drop dir (so it
 * overrides the built-in in the catalog) and append a new versioned history
 * entry. Returns the new version number. Idempotent per requestId only in the
 * sense that the caller (the approvals resolve) runs it exactly once.
 */
export async function applyApproved(
  payload: AssistProposalPayload,
  requestId: string,
  author: string,
): Promise<number> {
  const id = safeAssistId(payload.assistId);
  if (!id) throw new Error(`invalid assist id: "${payload.assistId}"`);

  const content = await readProposalContent(id, requestId);
  // Re-validate at apply time — the proposal was validated at submit, but this
  // is a second gate so an approve can never write an invalid/secret-bearing
  // body even if the on-disk proposal were tampered with.
  validateProposal(content);

  const history = await readHistory(id);
  const version = history.length > 0 ? history[history.length - 1].version + 1 : 1;

  // Freeze this version's content, THEN append the index line — so a crash
  // between the two leaves an orphan .md (harmless) rather than an index entry
  // pointing at a missing file.
  const entryDir = path.join(HISTORY_DIR(), id);
  await fs.mkdir(entryDir, { recursive: true });
  await fs.writeFile(path.join(entryDir, `${version}.md`), content, 'utf-8');

  const entry: HistoryEntry = {
    version,
    author,
    timestamp: new Date().toISOString(),
    message: payload.message,
  };
  await fs.appendFile(path.join(entryDir, 'index.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8');

  // Publish to the Local drop dir last — once this lands the catalog serves it.
  await fs.mkdir(LOCAL_ASSISTS_DIR(), { recursive: true });
  await fs.writeFile(path.join(LOCAL_ASSISTS_DIR(), `${id}.md`), content, 'utf-8');

  await removeProposal(id, requestId);
  logger.info(TAG, `applied approved proposal for "${id}" as version ${version} (by ${author})`);
  return version;
}

/** Discard a rejected proposal — remove the pending body, write NO local file. */
export async function discardRejected(payload: AssistProposalPayload, requestId: string): Promise<void> {
  const id = safeAssistId(payload.assistId);
  if (!id) return;
  await removeProposal(id, requestId);
  logger.info(TAG, `discarded rejected proposal for "${id}" (request ${requestId})`);
}
