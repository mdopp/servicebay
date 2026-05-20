/**
 * Migration audit-entry types — leaf module (#601 cycle-break).
 *
 * `config.ts` references `MigrationAuditEntry` in `AppConfig` to type
 * the persisted run history. `migrations.ts` also uses the type but
 * additionally imports `registry.ts` (which imports `config.ts`).
 * That's the 3-node cycle config → migrations → registry → config.
 *
 * Moving the type to this leaf module lets config.ts import it without
 * pulling in migrations.ts at all.
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
