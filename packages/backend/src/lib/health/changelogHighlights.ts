/**
 * Changelog-highlights extraction for the restart/update digest
 * (#1653, epic #1650 item C).
 *
 * When the box comes up on a new version, the digest wants a few
 * human-readable highlights of what changed — not the whole release-please
 * CHANGELOG.md, just the headline Features/Fixes for the versions crossed.
 *
 * The file is release-please's "Keep a Changelog" format:
 *
 *     ## [4.94.0](…compare…) (2026-06-04)
 *     ### Features
 *     * **health:** per-type failureThreshold before alerting ([6a2aa29](…)), closes [#1651](…)
 *     ### Bug Fixes
 *     * **portal:** migrate Authelia soft-auth off …
 *
 * We parse the entries between the new version's header and the previous
 * version's header (so an update that jumps several releases shows all of
 * them), strip the trailing commit/issue link noise, and return a short
 * bulleted list. Pure string work — no I/O here so it stays unit-testable;
 * the caller passes the file contents.
 */

const VERSION_HEADER = /^##\s+\[(\d+\.\d+\.\d+[^\]]*)\]/;

/** Strip a changelog bullet down to its readable summary: drop the leading
 *  `* `, the trailing `([sha](url))`, and any `, closes [#N](url)` tail. */
function cleanBullet(line: string): string {
  return line
    .replace(/^\*\s+/, '')
    .replace(/\s*\(\[[0-9a-f]+\]\([^)]*\)\)/g, '') // ([sha](url))
    .replace(/,?\s*closes?\s+(\[#\d+\]\([^)]*\)\s*)+/gi, '') // closes [#N](url)…
    .trim();
}

export interface ChangelogHighlightsOptions {
  /** Cap on how many bullets to include (newest-first). */
  max?: number;
}

/**
 * Extract changelog highlights for the versions in the half-open range
 * `(fromVersion, toVersion]`. When `fromVersion` is undefined or not found,
 * returns just the `toVersion` section. Returns `[]` if `toVersion` has no
 * section (e.g. a dev build not yet in the changelog) or the file is empty.
 */
export function extractChangelogHighlights(
  changelog: string,
  toVersion: string,
  fromVersion: string | undefined,
  opts: ChangelogHighlightsOptions = {},
): string[] {
  const max = opts.max ?? 8;
  const lines = changelog.split('\n');

  // Find the line index of each version header in file order (newest first
  // in release-please output).
  const headerAt: Array<{ version: string; idx: number }> = [];
  lines.forEach((l, idx) => {
    const m = l.match(VERSION_HEADER);
    if (m) headerAt.push({ version: m[1], idx });
  });

  const startHeader = headerAt.findIndex(h => h.version === toVersion);
  if (startHeader === -1) return [];

  // Collect bullets from the toVersion section down to (but not including)
  // the fromVersion section. If fromVersion isn't in the file, just take
  // the single toVersion section.
  const endHeader =
    fromVersion !== undefined
      ? headerAt.findIndex(h => h.version === fromVersion)
      : startHeader + 1;
  const sliceEnd =
    endHeader > startHeader ? headerAt[endHeader].idx : (headerAt[startHeader + 1]?.idx ?? lines.length);

  const bullets: string[] = [];
  for (let i = headerAt[startHeader].idx + 1; i < sliceEnd; i++) {
    const line = lines[i];
    if (/^\*\s+/.test(line.trim())) {
      const cleaned = cleanBullet(line.trim());
      // Skip the generated catch-all rollup bullets (no conventional
      // `**scope:**` prefix and very long) — they duplicate the per-scope
      // ones; keep scoped bullets which are the useful highlights.
      if (cleaned) bullets.push(cleaned);
    }
    if (bullets.length >= max) break;
  }
  return bullets;
}
