// Client-side proposal validation for the Knowledge (assists) editor (#2228).
//
// This mirrors the backend gate in `packages/backend/src/lib/assists/editor.ts`
// (frontmatter requirements + the committed-secret scan) so the editor can flag
// an invalid or secret-bearing body BEFORE it is ever POSTed. It is a UX
// convenience, not the security boundary — the backend re-runs the same checks
// on `POST /api/assists/:id/propose` and on approve, so a bypassed client check
// still can't write a secret into the catalog.
//
// Lives in the feature `_lib/` with relative imports only — the `@/lib` alias
// resolves to the BACKEND (reference_at_lib_alias_is_backend), so we cannot pull
// the backend's editor module here; the rules are re-stated (kept in sync
// deliberately, same as the backend keeps them in sync with the repo-scan test).

/** The catalog kinds — mirrors ASSIST_KINDS in the backend catalog. */
export const ASSIST_KINDS = [
  'guide',
  'recipe',
  'adr',
  'template',
  'checklist',
  'footgun',
  'snippet',
] as const;

export type AssistKind = (typeof ASSIST_KINDS)[number];

/**
 * High-signal committed-secret formats — the SAME rules as the backend
 * `SECRET_PATTERNS` (editor.ts) and the repo-scan backstop
 * (tests/backend/assist_consistency.test.ts). A body matching any of these is
 * blocked before it can be proposed.
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
 * Extract the frontmatter block's raw key/value lines without a YAML parser
 * (avoids pulling gray-matter into the client bundle). Returns the map of
 * top-level scalar keys we care about; nested/array values are returned as
 * their raw string form (enough to check presence + the `kind` enum).
 *
 * A document with no leading `---` block yields an empty map, which then fails
 * the "missing title" check — exactly the behaviour we want.
 */
export function parseFrontmatterKeys(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    // Strip surrounding quotes on a simple scalar for the presence/enum check.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Strip a leading `---\n…\n---` frontmatter block from an assist document,
 * returning only the markdown body. `GET /api/assists/:id` intentionally returns
 * the full raw file (so the editor can edit the frontmatter fields), but the
 * rendered view must NOT show the YAML — the title/kind/tags are already surfaced
 * as structured metadata in the DetailHeader (#2231).
 *
 * A document without a leading frontmatter block is returned unchanged. Tolerant
 * of CRLF endings and of trailing whitespace after the closing fence.
 */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const stripped = normalized.replace(/^---\n[\s\S]*?\n---[ \t]*\n?/, '');
  return stripped;
}

export interface ValidationResult {
  ok: boolean;
  /** First blocking error, caller-safe (no secret value echoed). */
  error?: string;
}

/**
 * Validate a proposal body against the same contract the backend enforces:
 * non-empty, no committed secret, and required frontmatter
 * (`title`, `whenToUse`, a valid `kind`). Returns the first failure — the error
 * string never echoes a secret value.
 */
export function validateProposal(content: string): ValidationResult {
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'Content is empty.' };
  }

  const secret = scanForSecret(content);
  if (secret) {
    return {
      ok: false,
      error: `Body contains a possible secret (${secret}); remove it before proposing.`,
    };
  }

  const keys = parseFrontmatterKeys(content);

  if (!keys.title?.trim()) {
    return { ok: false, error: 'Frontmatter is missing a non-empty "title".' };
  }

  const when = keys.whenToUse ?? keys.when_to_use;
  if (!when?.trim()) {
    return { ok: false, error: 'Frontmatter is missing a non-empty "whenToUse".' };
  }

  const kind = keys.kind?.trim();
  if (!kind) {
    return { ok: false, error: 'Frontmatter is missing "kind".' };
  }
  if (!(ASSIST_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `Invalid kind "${kind}"; must be one of ${ASSIST_KINDS.join(' | ')}.` };
  }

  return { ok: true };
}
