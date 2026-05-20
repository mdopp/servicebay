/**
 * CHANGELOG.md parser + version-range filter for the template upgrade
 * system (#353 / #354 / #352).
 *
 * Each template's CHANGELOG.md is structured as H2-per-version:
 *
 *   ## v2 (breaking)
 *
 *   ...details...
 *
 *   ## v1
 *
 *   Initial release.
 *
 * The dashboard shows the operator only the sections relevant to their
 * pending upgrade — i.e. `v(installed+1)` … `v(current)`. Filtering
 * here keeps the UI generic.
 */

export interface ChangelogSection {
  version: number;
  /** True iff the H2 line contained `(breaking)` */
  breaking: boolean;
  /** Markdown body of the section, between this H2 and the next H2 */
  body: string;
}

const H2_RE = /^##\s+v(\d+)\b(.*)$/gm;

/**
 * Parse a CHANGELOG.md string into an ordered list of sections,
 * newest version first. Anything before the first H2 (e.g. a preamble)
 * is dropped — the format is purely sectioned by version.
 */
export function parseChangelog(markdown: string): ChangelogSection[] {
  if (!markdown) return [];
  const matches: { version: number; breaking: boolean; offset: number; lineEnd: number }[] = [];
  for (const m of markdown.matchAll(H2_RE)) {
    matches.push({
      version: parseInt(m[1], 10),
      breaking: /\(breaking\)/i.test(m[2] ?? ''),
      offset: m.index ?? 0,
      lineEnd: (m.index ?? 0) + m[0].length,
    });
  }
  const sections: ChangelogSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].lineEnd;
    const end = i + 1 < matches.length ? matches[i + 1].offset : markdown.length;
    sections.push({
      version: matches[i].version,
      breaking: matches[i].breaking,
      body: markdown.slice(start, end).trim(),
    });
  }
  // Newest first; tie-break by parse order (should never tie in practice).
  sections.sort((a, b) => b.version - a.version);
  return sections;
}

/**
 * Return only the sections relevant to an upgrade from `installed`
 * (exclusive) to `current` (inclusive). When `installed >= current`
 * returns an empty array (no pending upgrade). When `installed` is
 * unknown (e.g. a service deployed before tracking existed), treat
 * it as 1 — the conservative choice that surfaces all breaking
 * notices for unsure operators.
 */
export function filterUpgradeSections(
  sections: ChangelogSection[],
  installed: number | undefined,
  current: number,
): ChangelogSection[] {
  const from = installed && installed > 0 ? installed : 1;
  if (from >= current) return [];
  return sections.filter(s => s.version > from && s.version <= current);
}

export function hasBreakingChanges(sections: ChangelogSection[]): boolean {
  return sections.some(s => s.breaking);
}
