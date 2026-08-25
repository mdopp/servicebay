/**
 * Plan a **collective** template upgrade — #2602.
 *
 * Before this, the only way to move a service onto a newer template
 * schema-version was the install dialog, one service at a time. With 21
 * installed templates on the reference box that is 21 identical passes, so in
 * practice it does not happen: the deploy timestamps there span June to
 * August, and a fix that lives in a template version never reaches most
 * services.
 *
 * A bulk run is NOT a new mechanism. `runner.ts` already deploys many items in
 * one job and already topo-sorts them by `servicebay.dependencies`; the only
 * thing missing was an input that says "every service that is behind". This
 * module builds that input, and — because a template upgrade runs migrations
 * and #2595 made a wipe-config reinstall of `auth`/`media` genuinely
 * destructive — it builds the **preview** the operator sees first.
 *
 * The preview deliberately answers the question the pre-#2601 dialog got
 * wrong: *what will actually roll out?* Every entry is checked against the
 * same `selectMigrationChain` the runner uses, so a service whose migration
 * chain has a hole (exactly what left `media` and `home-assistant` nine days
 * stale) is named and EXCLUDED here, before the run — rather than aborting the
 * whole batch at that service and leaving everything after it undeployed.
 */
import { getConfig } from '../config';
import { getTemplateYaml, getTemplateMigrationScripts } from '../registry';
import { getPendingTemplateUpgrades } from '../templateUpgrades';
import { selectMigrationChain } from '../stackInstall/migrations';
import {
  parseTemplateDependencies,
  topoSortByDependencies,
} from '../stackInstall/dependencies';
import { parseTemplateTier } from '../templateTier';
import type { TemplateTier } from '../templateTier';

/** One migration hop that will run for a service in this plan. */
export interface PlannedMigration {
  filename: string;
  fromVersion: number;
  toVersion: number;
}

export interface BulkUpgradeEntry {
  name: string;
  installedVersion: number;
  currentVersion: number;
  hasBreakingChange: boolean;
  /** CHANGELOG section headers between installed and current, ascending. */
  sectionHeaders: string[];
  /** Templates this one must deploy after. Only those in the run. */
  dependencies: string[];
  tier: TemplateTier;
  /** Migration scripts that will run, in order. Empty is normal — a
   *  schema bump does not have to move anything on disk. */
  migrations: PlannedMigration[];
  /** Set only on `excluded` entries: why this service cannot roll out. */
  excludedReason?: string;
}

export interface BulkUpgradePlan {
  /** Services that will be deployed, in the order the runner will deploy
   *  them (same topo-sort, same implicit infrastructure-before-feature
   *  edges). */
  order: BulkUpgradeEntry[];
  /** Services that are behind but cannot roll out in this run, each with
   *  the reason. Kept OUT of `order` on purpose: the runner stops the whole
   *  job at the first failing item, so one broken chain would otherwise cost
   *  every service queued behind it. */
  excluded: BulkUpgradeEntry[];
  /** Installed services that take part only as dependency satisfiers. The
   *  caller sends these to the runner as `alreadyInstalled` items so the
   *  topo-sort does not reject a dependency that is deployed but not being
   *  upgraded. Not touched by the run. */
  satisfiers: string[];
  /** True when any entry in `order` carries a breaking CHANGELOG section —
   *  the caller gates the run behind an explicit acknowledgement. */
  hasBreakingChange: boolean;
}

/** Reason text for a chain that cannot be walked. Same wording the runner
 *  logs when it hits this mid-deploy, so the preview and the job log read
 *  the same (`runner.ts`, migration-chain discovery). */
function chainFailureReason(
  name: string,
  result: Exclude<ReturnType<typeof selectMigrationChain>, { ok: true }>,
): string {
  if (result.reason === 'missing-step') {
    const have = result.available.length === 0
      ? 'none'
      : result.available.map(v => `v${v}`).join(', ');
    return `Migration chain for ${name} is incomplete: no script for v${result.from}→v${result.expectedNext} (have ${have}). The deploy would abort.`;
  }
  return `Migration chain for ${name} has overlapping/invalid steps (${result.conflicts.map(c => `v${c.fromVersion}→v${c.toVersion}`).join(', ')}). The deploy would abort.`;
}

/**
 * Turn one "this service is behind" summary into a plan entry: its dependency
 * edges, its tier, and the migration hops the deploy would run — or an
 * `excludedReason` when the deploy could not succeed.
 */
async function describeCandidate(
  summary: Awaited<ReturnType<typeof getPendingTemplateUpgrades>>[number],
  source?: string,
): Promise<BulkUpgradeEntry> {
  const base: BulkUpgradeEntry = {
    name: summary.name,
    installedVersion: summary.installedVersion,
    currentVersion: summary.currentVersion,
    hasBreakingChange: summary.hasBreakingChange,
    sectionHeaders: summary.sectionHeaders,
    dependencies: [],
    tier: 'feature',
    migrations: [],
  };

  const yaml = await getTemplateYaml(summary.name, source).catch(() => null);
  if (yaml === null) {
    return {
      ...base,
      excludedReason: `No template named ${summary.name} in any configured registry — re-sync registries from Settings.`,
    };
  }
  // Full declared list, unfiltered: a dependency that is neither in the run
  // nor installed at all is exactly what the runner's topo-sort refuses on, so
  // the plan has to see it too. `orderByDependencies` narrows the list to the
  // run before it reaches the preview.
  base.dependencies = parseTemplateDependencies(yaml);
  base.tier = parseTemplateTier(yaml);

  // The chain check is the honest half of the preview: it is the exact refusal
  // that stopped media/home-assistant deploying (#2601), and it costs nothing
  // to answer before the run instead of during it.
  try {
    const scripts = await getTemplateMigrationScripts(summary.name, source);
    const chain = selectMigrationChain(summary.installedVersion, summary.currentVersion, scripts);
    if (!chain.ok) return { ...base, excludedReason: chainFailureReason(summary.name, chain) };
    base.migrations = chain.chain.map(s => ({
      filename: s.filename,
      fromVersion: s.fromVersion,
      toVersion: s.toVersion,
    }));
  } catch (e) {
    return {
      ...base,
      excludedReason: `Could not read ${summary.name}'s migration scripts (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
  return base;
}

/**
 * Build the plan for a bulk template upgrade.
 *
 * @param requested Names to include; `undefined` means "everything behind".
 *                  Names that are not actually behind are ignored — the
 *                  version comparison, not the caller, decides what is in.
 * @param source    Registry source to resolve templates from, as the install
 *                  job will.
 */
export async function planBulkTemplateUpgrade(
  requested?: ReadonlyArray<string>,
  source?: string,
): Promise<BulkUpgradePlan> {
  const pending = await getPendingTemplateUpgrades();
  const wanted = requested ? new Set(requested) : null;
  const selected = wanted ? pending.filter(p => wanted.has(p.name)) : pending;

  const config = await getConfig();
  const installedNames = Object.keys(config.installedTemplates ?? {});

  const candidates: BulkUpgradeEntry[] = [];
  const excluded: BulkUpgradeEntry[] = [];
  for (const summary of selected) {
    const entry = await describeCandidate(summary, source);
    (entry.excludedReason ? excluded : candidates).push(entry);
  }

  const { ordered, dropped } = orderByDependencies(candidates, installedNames);
  excluded.push(...dropped);

  const orderedNames = new Set(ordered.map(o => o.name));
  return {
    order: ordered,
    excluded,
    satisfiers: installedNames.filter(n => !orderedNames.has(n)).sort(),
    hasBreakingChange: ordered.some(o => o.hasBreakingChange),
  };
}

/**
 * Topo-sort the runnable set with the SAME function the runner uses, so the
 * order the preview shows is the order the job runs — not a second ordering
 * that can drift from it.
 *
 * A sort failure drops the offending entries and retries rather than voiding
 * the whole plan: one service with an uninstalled dependency (or a template-
 * authoring cycle) must not cost the operator the other twenty. The loop is
 * bounded by the candidate count — each pass removes at least one entry.
 */
function orderByDependencies(
  candidates: BulkUpgradeEntry[],
  installedNames: ReadonlyArray<string>,
): { ordered: BulkUpgradeEntry[]; dropped: BulkUpgradeEntry[] } {
  const dropped: BulkUpgradeEntry[] = [];
  let remaining = candidates;

  for (let pass = 0; pass <= candidates.length; pass++) {
    if (remaining.length === 0) return { ordered: [], dropped };
    const inRun = new Set(remaining.map(r => r.name));
    const satisfiers = new Set(installedNames.filter(n => !inRun.has(n)));
    const result = topoSortByDependencies(
      remaining.map(r => ({
        name: r.name,
        dependencies: r.dependencies,
        tier: r.tier,
        entry: r,
      })),
      { alreadyInstalled: satisfiers },
    );
    if (result.ok) {
      return {
        // Narrow each entry's dependency list to what is actually in the run,
        // so the preview's "after X" reads as ordering within this run rather
        // than as the template's full declaration.
        ordered: result.ordered.map(r => ({
          ...r.entry,
          dependencies: r.entry.dependencies.filter(d => inRun.has(d)),
        })),
        dropped,
      };
    }
    const offenders = result.reason === 'missing' ? [result.item] : result.involved;
    const reason = result.reason === 'missing'
      ? `Depends on ${result.missing.join(', ')}, which ${result.missing.length === 1 ? 'is' : 'are'} not installed — install ${result.missing.length === 1 ? 'it' : 'them'} first.`
      : `Part of a template dependency cycle (${result.involved.join(' ↔ ')}) — this is a template-authoring bug, please report it.`;
    for (const name of offenders) {
      const hit = remaining.find(r => r.name === name);
      if (hit) dropped.push({ ...hit, excludedReason: reason });
    }
    remaining = remaining.filter(r => !offenders.includes(r.name));
  }

  return { ordered: [], dropped: [...dropped, ...remaining] };
}
