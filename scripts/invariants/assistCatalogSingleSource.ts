/**
 * Invariant 8c — the assist catalog has exactly ONE source (#2701, ADR 0014).
 * Extracted from `scripts/check-invariants.ts`, which is at its max-lines
 * budget; the driver there calls `auditAssistCatalogSingleSource` and folds the
 * result into the shared violation/measurement lists.
 *
 * The catalog is delivered at runtime (`packages/backend/src/lib/assists/
 * delivery.ts`) and deliberately NOT baked into the container image. Baking it
 * in was the original defect: it made a catalog entry an *image artifact*, so a
 * `docs(assists):` commit — which cuts no release — never reached a running box.
 *
 * The operator's decision came with one binding condition: **afterwards there
 * must be exactly one source.** A catalog that stayed in the image while the
 * disk was layered over it would be two sources, one of which ages, and an
 * assist that reads differently in the image than on disk is worse than a
 * missing one — it answers, and answers wrongly.
 *
 * Prose could not hold that condition; a script can. Two ways back to two
 * sources, both failed here:
 *
 *   1. a `COPY … assists` in the `Dockerfile` — the original mechanism;
 *   2. a `process.cwd()/assists` fallback in the loader — the same thing by
 *      accident, because `process.cwd()` IS `/app` at runtime, so a "harmless
 *      default" silently reads the image copy again.
 *
 * The behavioural half of the contract (a failed delivery is empty and loud,
 * never stale and quiet) is not checkable from file text; it lives in
 * `delivery.ts:resolveCatalogDir` and its tests.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AssistCatalogAuditResult {
  check: string;
  problems: string[];
  measurement: string | null;
}

/** Pure text audit — exported so the suite can exercise the RED path. */
export function auditAssistCatalogSource(dockerfile: string, loader: string): string[] {
  const problems: string[] = [];

  // A COPY whose destination is the image's assists dir.
  const copyLine = dockerfile
    .split('\n')
    .find(l => /^\s*COPY\b/.test(l) && /(^|\s)\.?\/?assists\/?\s*$/.test(l));
  if (copyLine) {
    problems.push(
      `Dockerfile copies the assist catalog into the image ("${copyLine.trim()}"). The catalog is delivered at runtime (#2701, ADR 0014) — a baked-in copy is a second source that ages beside the delivered one.`,
    );
  }

  if (/process\.cwd\(\)\s*,\s*['"]assists['"]/.test(loader)) {
    problems.push(
      'packages/backend/src/lib/assists/catalog.ts resolves a catalog dir from process.cwd() again. The delivered dir (delivery.ts:resolveCatalogDir) is the only source; a cwd fallback silently reintroduces the image copy (#2701).',
    );
  }

  return problems;
}

export async function auditAssistCatalogSingleSource(repoRoot: string): Promise<AssistCatalogAuditResult> {
  const check = 'assist-catalog-single-source';
  let dockerfile: string;
  let loader: string;
  try {
    [dockerfile, loader] = await Promise.all([
      readFile(path.join(repoRoot, 'Dockerfile'), 'utf-8'),
      readFile(path.join(repoRoot, 'packages/backend/src/lib/assists/catalog.ts'), 'utf-8'),
    ]);
  } catch (e) {
    return {
      check,
      problems: [`could not read Dockerfile / assist loader: ${e instanceof Error ? e.message : String(e)}`],
      measurement: null,
    };
  }

  const problems = auditAssistCatalogSource(dockerfile, loader);
  return {
    check,
    problems,
    measurement:
      problems.length === 0
        ? 'assist catalog: one source — no image COPY, no process.cwd() fallback (delivered at runtime, #2701)'
        : null,
  };
}
