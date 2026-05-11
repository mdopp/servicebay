/**
 * Chain selection + audit-shape for template migration scripts (#352
 * phase 3).
 *
 * Discovery + raw script content come from
 * `registry.ts:getTemplateMigrationScripts`. This module turns the
 * unsorted result into the ordered list of scripts that should run for
 * a given `(installedVersion → currentVersion)` upgrade, and surfaces
 * the missing-step / overlap / skip-version pathologies as typed
 * results instead of silent no-ops.
 *
 * Pure module — no I/O, no React. Importable from both the server-
 * side deploy pipeline and the client-side hook.
 */

import type { TemplateMigrationScript } from '@/lib/registry';

export type MigrationChainResult =
  | { ok: true; chain: TemplateMigrationScript[] }
  | { ok: false; reason: 'missing-step'; from: number; expectedNext: number; available: number[] }
  | { ok: false; reason: 'overlapping-steps'; conflicts: { fromVersion: number; toVersion: number }[] };

/**
 * Pick the ordered chain of migration scripts that walks
 * `installedVersion → ... → targetVersion`.
 *
 * Returns an empty chain when `installedVersion >= targetVersion`
 * (no migration needed — fresh install or already-current) or when
 * `installedVersion` is null (no prior install — treat as fresh).
 *
 * Steps must be contiguous one-version hops. A v1→v3 file that skips
 * v2 is treated as missing the v1→v2 step: returns
 * `missing-step` with `from=1, expectedNext=2`.
 *
 * Overlapping hops (two scripts both upgrade from v2, or
 * `v2-to-v4.py` overlaps `v3-to-v4.py`) return `overlapping-steps`.
 * The consistency test should already prevent these at build time,
 * but the runtime check protects against external-registry drift.
 */
export function selectMigrationChain(
  installedVersion: number | null,
  targetVersion: number,
  scripts: TemplateMigrationScript[],
): MigrationChainResult {
  // No prior install OR no version delta → no migration. The fresh-
  // install path stamps `installedTemplates[name].schemaVersion` to
  // the new version directly without running migration steps.
  if (installedVersion === null) return { ok: true, chain: [] };
  if (installedVersion >= targetVersion) return { ok: true, chain: [] };

  // Index by fromVersion. Surface overlaps loudly — two scripts from
  // the same fromVersion means the chain is ambiguous.
  const byFrom = new Map<number, TemplateMigrationScript>();
  const conflicts: { fromVersion: number; toVersion: number }[] = [];
  for (const s of scripts) {
    if (s.toVersion !== s.fromVersion + 1) {
      conflicts.push({ fromVersion: s.fromVersion, toVersion: s.toVersion });
      continue;
    }
    const prev = byFrom.get(s.fromVersion);
    if (prev) {
      conflicts.push({ fromVersion: prev.fromVersion, toVersion: prev.toVersion });
      conflicts.push({ fromVersion: s.fromVersion, toVersion: s.toVersion });
      continue;
    }
    byFrom.set(s.fromVersion, s);
  }
  if (conflicts.length > 0) {
    // De-duplicate by stable key
    const seen = new Set<string>();
    const unique = conflicts.filter(c => {
      const k = `${c.fromVersion}-${c.toVersion}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ok: false, reason: 'overlapping-steps', conflicts: unique };
  }

  const chain: TemplateMigrationScript[] = [];
  for (let v = installedVersion; v < targetVersion; v++) {
    const step = byFrom.get(v);
    if (!step) {
      return {
        ok: false,
        reason: 'missing-step',
        from: v,
        expectedNext: v + 1,
        available: Array.from(byFrom.keys()).sort((a, b) => a - b),
      };
    }
    chain.push(step);
  }
  return { ok: true, chain };
}

/**
 * Audit-log entry persisted in `config.serviceMigrations[name]`.
 * One entry per migration step that ran, success or failure. The
 * diagnose page surfaces failed entries so the operator can act on
 * them without trawling install logs.
 */
export interface MigrationAuditEntry {
  /** ISO timestamp of when the script finished. */
  ranAt: string;
  fromVersion: number;
  toVersion: number;
  /** 0 = success; non-zero aborted the deploy. */
  exitCode: number;
  /** Last ~1KB of stdout for "what happened" diagnosis. */
  stdoutTail?: string;
}
