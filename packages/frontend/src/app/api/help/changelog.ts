/**
 * Turn the raw release-please `CHANGELOG.md` into a user-facing "What's new"
 * view (#1262). Two problems with serving it verbatim:
 *
 *  1. Every change appears twice — the squash-merge commit and the PR-merge
 *     commit both carry the same conventional-commit subject, so release-please
 *     emits a duplicate pair (identical text, different hash) per change.
 *  2. Entries are raw commit subjects: a bold `**scope:**` prefix plus a
 *     trailing `([hash](link))` that mean nothing to an end user.
 *
 * This transform dedupes consecutive identical entries (ignoring the hash) and
 * strips the scope prefix + hash link, leaving a plain sentence. It only
 * touches bullet lines; version headings (`## [x.y.z]`) and section headings
 * (`### Features`) pass through untouched. We never edit CHANGELOG.md itself —
 * release-please owns it; this is render-time only.
 */

const BULLET_RE = /^(\s*[*-]\s+)(.*)$/;
// Trailing commit-hash link: ` ([abc1234](https://…))` or a bare ` (abc1234)`.
const HASH_LINK_RE = /\s*\(\[[0-9a-f]{6,}\]\([^)]*\)\)\s*$/i;
const BARE_HASH_RE = /\s*\([0-9a-f]{7,}\)\s*$/i;
// Conventional-commit scope prefix as release-please renders it: `**scope:**`.
const SCOPE_PREFIX_RE = /^\*\*[^*]+:\*\*\s*/;

function cleanEntry(text: string): string {
  let t = text.replace(HASH_LINK_RE, '').replace(BARE_HASH_RE, '').trim();
  t = t.replace(SCOPE_PREFIX_RE, '').trim();
  if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

export function renderChangelogForUsers(markdown: string): string {
  const out: string[] = [];
  // Dedupe is scoped to a run of bullets; a heading or blank line resets it so
  // an unrelated later release that repeats a subject isn't swallowed.
  let lastEntry: string | null = null;
  for (const line of markdown.split('\n')) {
    const m = line.match(BULLET_RE);
    if (m) {
      const entry = cleanEntry(m[2]);
      if (!entry) continue;
      const key = entry.toLowerCase();
      if (key === lastEntry) continue; // duplicate pair — drop the second
      lastEntry = key;
      out.push(`${m[1]}${entry}`);
    } else {
      lastEntry = null;
      out.push(line);
    }
  }
  return out.join('\n');
}
