/**
 * Server-side install PLAN — the single source of truth for the
 * desired-state install rules (#1520).
 *
 * Both clients (the `sb` CLI's desired-state panel and the HTML wizard)
 * used to re-derive "given the stacks the operator wants, what do we
 * install / reinstall / uninstall?" independently — Go in one, TS in
 * the other — and drift. This module computes that diff once, on the
 * box, from the catalog + live health, so the clients become thin
 * renderers of the same plan.
 *
 * The rules mirror the CLI's desired-state editor:
 *   - desired + not installed        → install
 *   - desired + installed + reinstall → reinstall (explicit redeploy over data)
 *   - desired + installed            → no-op
 *   - installed + not desired + wipeable    → uninstall
 *   - installed + not desired + atomic-wipe → BLOCKED (core; Factory Reset only)
 *   - desired + unknown stack        → BLOCKED (not in the catalog)
 *
 * There is no clean-install / preserve concept here — reinstall is a
 * plain redeploy over existing data and the system-wide wipe lives only
 * in the explicit Factory Reset flow, exactly as the CLI models it.
 */
import { getTemplates, getStackManifest } from '@/lib/registry';
import { getStackHealth } from './stackHealth';
import { logger } from '@/lib/logger';

/** One catalog entry reduced to just what the plan diff needs. Pure
 *  input so `computeInstallPlan` is unit-testable with no IO. */
export interface PlanStack {
  name: string;
  /** A health signal exists for at least one of the stack's templates
   *  (the box's "installed" signal — `health.hasAnySignal`). */
  installed: boolean;
  /** `spec.templates` — the deployable units. */
  templates: string[];
  /** `lifecycle: atomic-wipe` (the core stack) — can't be uninstalled
   *  here; teardown is Factory-Reset-only. */
  atomicWipe: boolean;
  /** False when the stack name isn't in the catalog / has no manifest. */
  known: boolean;
}

export interface PlanStackChange {
  stack: string;
  templates: string[];
}

export interface InstallPlan {
  /** Desired stacks not yet installed — deploy their templates. */
  install: PlanStackChange[];
  /** Installed stacks the operator explicitly wants redeployed over data. */
  reinstall: PlanStackChange[];
  /** Installed stacks no longer desired — tear them down (wipeable only). */
  uninstall: { stack: string }[];
  /** Desired/undesired changes that can't be applied, with why. */
  blocked: { stack: string; reason: string }[];
  /** De-duplicated template names to deploy this apply (install ∪ reinstall),
   *  in catalog order — the input to `assembleManifest`. */
  templatesToDeploy: string[];
  /** True when nothing changes (desired set already matches reality). */
  noop: boolean;
}

type StackVerdict = 'install' | 'reinstall' | 'uninstall' | 'noop' | { blocked: string };

/** The desired-state rule for one stack — pure, the heart of the diff. */
function classifyStack(s: PlanStack, wanted: boolean, wantReinstall: boolean): StackVerdict {
  if (wanted && !s.installed) return 'install';
  if (wanted && s.installed) return wantReinstall ? 'reinstall' : 'noop';
  if (!wanted && s.installed) {
    return s.atomicWipe ? { blocked: 'core stack — uninstall via Factory Reset, not here' } : 'uninstall';
  }
  return 'noop'; // not desired, not installed
}

/**
 * Pure desired-state diff. `catalog` is every known stack with its
 * installed flag; `desired` is the set the operator wants installed;
 * `reinstall` is the subset of installed+desired stacks to redeploy.
 */
export function computeInstallPlan(
  catalog: PlanStack[],
  desired: readonly string[],
  reinstall: readonly string[] = [],
): InstallPlan {
  const desiredSet = new Set(desired);
  const reinstallSet = new Set(reinstall);
  const byName = new Map(catalog.map(s => [s.name, s]));
  const plan: InstallPlan = { install: [], reinstall: [], uninstall: [], blocked: [], templatesToDeploy: [], noop: false };

  // Desired stacks the catalog doesn't know → blocked (typo / missing registry).
  for (const name of desiredSet) {
    const s = byName.get(name);
    if (!s || !s.known) plan.blocked.push({ stack: name, reason: 'unknown stack (not in the catalog)' });
  }

  const seen = new Set<string>();
  const deploy = (s: PlanStack, into: PlanStackChange[]) => {
    into.push({ stack: s.name, templates: s.templates });
    for (const t of s.templates) {
      if (!seen.has(t)) {
        seen.add(t);
        plan.templatesToDeploy.push(t);
      }
    }
  };

  for (const s of catalog) {
    if (!s.known) continue;
    const verdict = classifyStack(s, desiredSet.has(s.name), reinstallSet.has(s.name));
    if (verdict === 'install') deploy(s, plan.install);
    else if (verdict === 'reinstall') deploy(s, plan.reinstall);
    else if (verdict === 'uninstall') plan.uninstall.push({ stack: s.name });
    else if (typeof verdict === 'object') plan.blocked.push({ stack: s.name, reason: verdict.blocked });
  }

  plan.noop = plan.install.length === 0 && plan.reinstall.length === 0 && plan.uninstall.length === 0;
  return plan;
}

/**
 * Build the live plan: enumerate the catalog (built-in + every external
 * registry, same source as `/api/system/stacks`), read each stack's
 * manifest + health, then run the pure diff. `node` selects which node's
 * twin health to read (defaults to the single local node).
 */
export async function buildInstallPlan(
  desired: readonly string[],
  reinstall: readonly string[] = [],
  node?: string,
): Promise<InstallPlan> {
  const all = await getTemplates();
  const names = Array.from(new Set(all.filter(t => t.type === 'stack').map(t => t.name)));

  const catalog: PlanStack[] = await Promise.all(
    names.map(async (name): Promise<PlanStack> => {
      try {
        const manifest = await getStackManifest(name);
        if (!manifest) {
          return { name, installed: false, templates: [], atomicWipe: false, known: false };
        }
        const health = await getStackHealth(name, node);
        return {
          name,
          installed: health?.hasAnySignal ?? false,
          templates: manifest.templates,
          atomicWipe: manifest.lifecycle === 'atomic-wipe',
          known: true,
        };
      } catch (e) {
        logger.warn('install:plan', `Failed to load stack ${name}: ${e instanceof Error ? e.message : String(e)}`);
        return { name, installed: false, templates: [], atomicWipe: false, known: false };
      }
    }),
  );

  return computeInstallPlan(catalog, desired, reinstall);
}
