/**
 * Stack-level install orchestrator (#633 / Phase 5A).
 *
 * Sequential-with-resume install across a stack's templates. The
 * existing per-template runner (`runner.ts`) still drives each
 * template's deploy + post-deploy + capability-bus emit; this module
 * is the glue that gates a stack on cross-stack dependencies and
 * orders the templates within a stack.
 *
 * Why not extend `runner.ts` in place: the per-template runner is the
 * unit of work the wizard's UI shows progress for. Stack runner
 * decides which units of work to run + in what order; the two
 * separations are intentional.
 *
 * Atomic-rollback is NOT in v1. If template N fails, templates 0..N-1
 * stay deployed and the stack reports `partially-installed`. The
 * operator retries — `prepareStackInstall` figures out what's left to
 * deploy, the runner does just those. Sequential-with-resume semantics
 * per the user-locked design.
 */
import { getStackManifest } from '@/lib/registry';
import type { StackManifest } from '@/lib/template/stackContract';
import { getStackHealth, getDegradedCoreSummary, type StackHealth, type DegradedCoreEntry } from './stackHealth';
import { topoSortByDependencies } from '@/lib/stackInstall/dependencies';
import { logger } from '@/lib/logger';

export interface StackInstallPlan {
  stack: StackManifest;
  /** Templates to deploy in this run, in install order. Excludes those
   *  already-installed-and-healthy. */
  order: string[];
  /** Per-template state at plan time. */
  status: Record<string, 'pending' | 'already-installed'>;
}

export interface StackInstallPreflight {
  ok: boolean;
  blockedBy: Array<{ stack: string; health: StackHealth | null; reason: string }>;
}

/**
 * Check that every stack listed in `manifest.dependsOnStacks` is
 * fully healthy. Used at the top of `installStack` to refuse with a
 * clear error rather than starting and failing later when the install
 * runner can't reach an upstream service.
 *
 * `null` for a dependency means the stack has no manifest yet (legacy
 * README-only) — treated as `ok: false` with a specific message so
 * the operator sees "install the basic stack first" instead of a
 * confusing "missing manifest" message.
 */
export async function preflightCrossStackDeps(
  manifest: StackManifest,
  nodeName: string = 'Local',
): Promise<StackInstallPreflight> {
  if (manifest.dependsOnStacks.length === 0) return { ok: true, blockedBy: [] };
  const blockedBy: StackInstallPreflight['blockedBy'] = [];
  for (const dep of manifest.dependsOnStacks) {
    const health = await getStackHealth(dep, nodeName);
    if (health === null) {
      blockedBy.push({
        stack: dep,
        health: null,
        reason: `dependency stack \`${dep}\` is not installed (no stack.yml found)`,
      });
      continue;
    }
    if (!health.ready) {
      const offenders = Object.entries(health.children)
        .filter(([, s]) => s !== 'ready')
        .map(([n, s]) => `${n}=${s}`)
        .join(', ');
      blockedBy.push({
        stack: dep,
        health,
        reason: `dependency stack \`${dep}\` is not healthy: ${offenders}`,
      });
    }
  }
  return { ok: blockedBy.length === 0, blockedBy };
}

/**
 * Resolve which templates in this stack still need to be deployed and
 * the order to deploy them in.
 *
 * `alreadyHealthy` is the set of template names whose `twin.health.
 * ready === true` right now — those get marked `already-installed` and
 * skipped. The remaining templates are topo-sorted by their per-
 * template `servicebay.dependencies` annotation.
 *
 * Returns `null` if the topo-sort detects a cycle or a missing dep —
 * the consistency lint catches both at build time so this should only
 * happen mid-install if a registry update changed the dep graph
 * underneath the operator.
 */
export async function prepareStackInstall(
  stackName: string,
  alreadyHealthy: ReadonlySet<string>,
  loadTemplateYaml: (name: string) => Promise<string | null>,
): Promise<{ ok: true; plan: StackInstallPlan } | { ok: false; error: string }> {
  const manifest = await getStackManifest(stackName);
  if (!manifest) {
    return { ok: false, error: `Stack \`${stackName}\` has no manifest.` };
  }

  // Pull per-template dependency annotations to feed topoSortByDependencies.
  // The function operates on `{ name, dependencies, ... }` items; we
  // construct the minimal shape it needs.
  const items = [];
  for (const tName of manifest.templates) {
    const yaml = await loadTemplateYaml(tName);
    if (!yaml) {
      return { ok: false, error: `Template \`${tName}\` referenced by stack \`${stackName}\` not found.` };
    }
    const deps = parseTemplateDeps(yaml).filter(d => manifest.templates.includes(d));
    items.push({
      name: tName,
      checked: true,
      alreadyInstalled: alreadyHealthy.has(tName),
      dependencies: deps,
    });
  }

  const sorted = topoSortByDependencies(items, {
    alreadyInstalled: alreadyHealthy,
  });
  if (!sorted.ok) {
    if (sorted.reason === 'missing') {
      return {
        ok: false,
        error: `Template \`${sorted.item}\` depends on ${sorted.missing.join(', ')}, which ${sorted.missing.length === 1 ? 'is' : 'are'} not in stack \`${stackName}\`.`,
      };
    }
    return {
      ok: false,
      error: `Templates in stack \`${stackName}\` form a dependency cycle: ${sorted.involved.join(' ↔ ')}.`,
    };
  }

  const order = sorted.ordered.map(i => i.name);
  const status: Record<string, 'pending' | 'already-installed'> = {};
  for (const name of manifest.templates) {
    status[name] = alreadyHealthy.has(name) ? 'already-installed' : 'pending';
  }
  // Trim `order` to only the not-yet-installed templates while preserving
  // their relative topo order.
  const toDeploy = order.filter(n => !alreadyHealthy.has(n));

  return {
    ok: true,
    plan: {
      stack: manifest,
      order: toDeploy,
      status,
    },
  };
}

/**
 * Minimal `servicebay.dependencies` parser. Mirrors the regex in the
 * full template-manifest parser but stays inline so this module can
 * stay independent of the full parsing surface (and so the stackRunner
 * test suite doesn't need to drag in the heavier dependencies).
 */
function parseTemplateDeps(yamlText: string): string[] {
  const m = /^\s+servicebay\.dependencies:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+?))\s*$/m.exec(yamlText);
  if (!m) return [];
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** What the operator-visible install loop reports as it goes. */
export type StackInstallProgress =
  | { kind: 'preflight-failed'; blockedBy: StackInstallPreflight['blockedBy'] }
  | { kind: 'tier-gate-failed'; degraded: DegradedCoreEntry[] }
  | { kind: 'plan'; plan: StackInstallPlan }
  | { kind: 'template-start'; template: string }
  | { kind: 'template-ok'; template: string }
  | { kind: 'template-failed'; template: string; error: string }
  | { kind: 'stack-ok'; stack: string }
  | { kind: 'stack-partial'; stack: string; failed: string };

export interface StackInstallOptions {
  nodeName?: string;
  loadTemplateYaml: (name: string) => Promise<string | null>;
  /** Returns the set of template names that are currently
   *  `twin.health.ready === true`. The runner uses this both for the
   *  preflight `alreadyHealthy` check AND for the per-template wait
   *  after deploy. */
  getReadyTemplates: () => Promise<Set<string>>;
  /** Deploy + post-deploy + bus.emit for a single template. Returns
   *  ok=true once the template's `twin.health.ready === true` (the
   *  caller polls `getReadyTemplates` against a deadline). */
  deployTemplate: (template: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Optional reporter for live log lines. */
  onProgress?: (event: StackInstallProgress) => void;
}

export async function installStack(
  stackName: string,
  opts: StackInstallOptions,
): Promise<{ ok: boolean; failedAt?: string; error?: string }> {
  const manifest = await getStackManifest(stackName);
  if (!manifest) {
    return { ok: false, error: `Stack \`${stackName}\` has no manifest.` };
  }
  const node = opts.nodeName ?? 'Local';

  // Tier gate (#635 / Phase 5C): refuse feature-stack installs when any
  // tier:core stack isn't healthy. The user-locked rule has no override
  // — operator must fix core first. Core stack installs (self-install
  // or re-install) bypass this gate; otherwise an unhealthy core would
  // prevent the operator from running the install that would fix it.
  if (manifest.tier === 'feature') {
    const degraded = await getDegradedCoreSummary(node);
    if (degraded.length > 0) {
      opts.onProgress?.({ kind: 'tier-gate-failed', degraded });
      const summary = degraded.map(d => {
        const offenders = d.notReady.map(n => `${n.template}(${n.state})`).join(', ');
        return `${d.stack}: ${offenders}`;
      }).join('; ');
      return {
        ok: false,
        error: `Cannot install \`${stackName}\`: core not ready — ${summary}. Fix core services first.`,
      };
    }
  }

  // Cross-stack dep gate.
  const pre = await preflightCrossStackDeps(manifest, node);
  if (!pre.ok) {
    opts.onProgress?.({ kind: 'preflight-failed', blockedBy: pre.blockedBy });
    return {
      ok: false,
      error: `Stack \`${stackName}\` install refused: ${pre.blockedBy.map(b => b.reason).join('; ')}`,
    };
  }

  // Plan.
  const alreadyHealthy = await opts.getReadyTemplates();
  const planResult = await prepareStackInstall(stackName, alreadyHealthy, opts.loadTemplateYaml);
  if (!planResult.ok) {
    return { ok: false, error: planResult.error };
  }
  opts.onProgress?.({ kind: 'plan', plan: planResult.plan });

  // Sequential deploy. On failure of template N, stop — sibling
  // templates further down the order would still race on N's
  // unmet dependency.
  for (const template of planResult.plan.order) {
    opts.onProgress?.({ kind: 'template-start', template });
    const result = await opts.deployTemplate(template);
    if (!result.ok) {
      opts.onProgress?.({ kind: 'template-failed', template, error: result.error });
      opts.onProgress?.({ kind: 'stack-partial', stack: stackName, failed: template });
      logger.warn('StackRunner', `Stack ${stackName} partially installed; template ${template} failed: ${result.error}`);
      return { ok: false, failedAt: template, error: result.error };
    }
    opts.onProgress?.({ kind: 'template-ok', template });
  }

  opts.onProgress?.({ kind: 'stack-ok', stack: stackName });
  return { ok: true };
}
