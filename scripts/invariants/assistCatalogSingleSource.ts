/**
 * Invariant 8c — the delivered agent kit has exactly ONE source (#2701/#2908/
 * #2909, ADR 0014). The kit is the assist catalog, the agent CLI and the
 * AGENTS.md template: each widening carried the one delivery further, so this
 * gate widened with it rather than growing a second check beside it.
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
 * And two more the CLI opened (#2908):
 *
 *   3. a delivered directory dropped from `AGENT_KIT_SUBDIRS` — the sparse set
 *      IS the delivery, so a path missing there is being served from elsewhere;
 *   4. a kit root handed out without `resolveAgentKitDir()` — i.e. a mount point
 *      that skips the freshness gate and quietly serves an aged checkout.
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

/**
 * The delivered directories, and the file that must be the ONE place they are
 * declared. #2908 widened the delivery to carry the agent CLI, #2909 the
 * AGENTS.md template; the condition is unchanged, so the gate covers each new
 * half the same way. A dir added to the kit and not added here is a dir whose
 * second source nobody would notice.
 */
const DELIVERED_DIRS = ['assists', 'agent-cli', 'agent-docs'] as const;

/** Pure text audit — exported so the suite can exercise the RED path. */
export function auditAssistCatalogSource(dockerfile: string, loader: string, delivery = ''): string[] {
  const problems: string[] = [];

  for (const dir of DELIVERED_DIRS) {
    // A COPY whose destination is the image's copy of a delivered dir.
    const copyLine = dockerfile
      .split('\n')
      .find(l => /^\s*COPY\b/.test(l) && new RegExp(`(^|\\s)\\.?/?${dir}/?\\s*$`).test(l));
    if (copyLine) {
      problems.push(
        `Dockerfile copies ${dir}/ into the image ("${copyLine.trim()}"). The agent kit is delivered at runtime (#2701/#2908, ADR 0014) — a baked-in copy is a second source that ages beside the delivered one.`,
      );
    }

    if (new RegExp(`process\\.cwd\\(\\)\\s*,\\s*['"]${dir}['"]`).test(loader)) {
      problems.push(
        `packages/backend/src/lib/assists/catalog.ts resolves ${dir}/ from process.cwd() again. The delivered dir (delivery.ts:resolveCatalogDir / resolveAgentKitDir) is the only source; a cwd fallback silently reintroduces the image copy (#2701).`,
      );
    }
  }

  // The sparse-checkout set is the delivery. If a directory is served but not
  // in that set, it is coming from somewhere else — which is the second source.
  if (delivery) {
    const set = /AGENT_KIT_SUBDIRS\s*=\s*\[([^\]]*)\]/.exec(delivery)?.[1] ?? '';
    for (const dir of DELIVERED_DIRS) {
      if (dir === 'assists' ? /CATALOG_SUBDIR/.test(set) : set.includes(`'${dir}'`)) continue;
      problems.push(
        `packages/backend/src/lib/assists/delivery.ts no longer lists ${dir}/ in AGENT_KIT_SUBDIRS, so the one delivery stopped carrying it (#2908). Widen that set — never add a second checkout or read path beside it.`,
      );
    }
    if (!/export async function resolveAgentKitDir/.test(delivery)) {
      problems.push(
        'packages/backend/src/lib/assists/delivery.ts no longer exports resolveAgentKitDir — the kit root must stay behind the same freshness gate as the catalog, not be handed out unchecked (#2908).',
      );
    }
  }

  return problems;
}

export async function auditAssistCatalogSingleSource(repoRoot: string): Promise<AssistCatalogAuditResult> {
  const check = 'assist-catalog-single-source';
  let dockerfile: string;
  let loader: string;
  let delivery: string;
  try {
    [dockerfile, loader, delivery] = await Promise.all([
      readFile(path.join(repoRoot, 'Dockerfile'), 'utf-8'),
      readFile(path.join(repoRoot, 'packages/backend/src/lib/assists/catalog.ts'), 'utf-8'),
      readFile(path.join(repoRoot, 'packages/backend/src/lib/assists/delivery.ts'), 'utf-8'),
    ]);
  } catch (e) {
    return {
      check,
      problems: [`could not read Dockerfile / assist loader / delivery: ${e instanceof Error ? e.message : String(e)}`],
      measurement: null,
    };
  }

  const problems = auditAssistCatalogSource(dockerfile, loader, delivery);
  return {
    check,
    problems,
    measurement:
      problems.length === 0
        ? `agent kit (${DELIVERED_DIRS.join(' + ')}): one source — no image COPY, no process.cwd() fallback, one sparse set behind one gate (#2701/#2908)`
        : null,
  };
}
